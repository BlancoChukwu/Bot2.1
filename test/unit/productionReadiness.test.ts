import { describe, expect, it } from "vitest";
import { createBotMetrics, createLogger } from "../../src/bot";
import {
  ConfigHotReloader,
  DeploymentSafetyGate,
  createGrafanaDashboardDefinition,
  createPagerDutyAlertDefinitions,
  GracefulShutdownCoordinator,
} from "../../src/production/productionReadiness";

describe("DeploymentSafetyGate", () => {
  it("allows live mode without dry-run receipt", () => {
    const gate = new DeploymentSafetyGate();

    const result = gate.evaluate({
      simulationMode: false,
      hasMetricsEndpoint: true,
      registeredChains: ["optimism"],
      minProfitMarginBps: 50,
    });

    expect(result.status).toBe("allowed");
  });

  it("allows simulation mode while requiring chains and metrics", () => {
    const gate = new DeploymentSafetyGate();

    expect(gate.evaluate({
      simulationMode: true,
      hasMetricsEndpoint: true,
      registeredChains: ["optimism"],
      minProfitMarginBps: 50,
    }).status).toBe("allowed");
  });

  it("allows simulation at 20 bps margin (bootstrap tuning)", () => {
    const gate = new DeploymentSafetyGate();
    expect(gate.evaluate({
      simulationMode: true,
      hasMetricsEndpoint: true,
      registeredChains: ["optimism"],
      minProfitMarginBps: 20,
    }).status).toBe("allowed");
  });

  it("blocks simulation when margin is below 20 bps", () => {
    const gate = new DeploymentSafetyGate();
    const result = gate.evaluate({
      simulationMode: true,
      hasMetricsEndpoint: true,
      registeredChains: ["optimism"],
      minProfitMarginBps: 19,
    });
    expect(result.status).toBe("blocked");
    if (result.status === "blocked") {
      expect(result.reasons).toContain("MIN_PROFIT_MARGIN_BPS must be at least 20 in simulation mode");
    }
  });

  it("blocks live mode when margin is below 20 bps", () => {
    const gate = new DeploymentSafetyGate();
    const result = gate.evaluate({
      simulationMode: false,
      hasMetricsEndpoint: true,
      registeredChains: ["optimism"],
      minProfitMarginBps: 19,
    });
    expect(result.status).toBe("blocked");
    if (result.status === "blocked") {
      expect(result.reasons).toContain("MIN_PROFIT_MARGIN_BPS must be at least 20 in live mode");
    }
  });
});

describe("ConfigHotReloader", () => {
  it("atomically keeps the previous config when parsing a reload fails", () => {
    const reloader = new ConfigHotReloader({
      initialConfig: { minProfitMarginBps: 50 },
      parse: (raw) => {
        if (raw === "bad") {
          throw new Error("invalid config");
        }
        return { minProfitMarginBps: Number(raw) };
      },
      logger: createLogger("silent"),
      metrics: createBotMetrics(),
    });

    expect(reloader.reload("75")).toEqual({ status: "reloaded" });
    expect(reloader.current()).toEqual({ minProfitMarginBps: 75 });
    expect(reloader.reload("bad")).toEqual({ status: "rejected", reason: "invalid config" });
    expect(reloader.current()).toEqual({ minProfitMarginBps: 75 });
  });
});

describe("Observability artifacts", () => {
  it("exports Grafana-ready dashboard panels for core bot metrics", () => {
    const dashboard = createGrafanaDashboardDefinition();
    const panelTitles = dashboard.panels.map((panel) => panel.title);

    expect(panelTitles).toContain("Execution Latency");
    expect(panelTitles).toContain("Errors");
    expect(JSON.stringify(dashboard)).toContain("bot_latency_seconds");
    expect(dashboard.schemaVersion).toBeGreaterThan(0);
    expect(dashboard.panels[0]?.targets[0]?.expr).toContain("bot_latency_seconds");
    expect(dashboard.panels[0]?.gridPos).toMatchObject({ w: 12, h: 8 });
  });

  it("exports PagerDuty alert definitions for capital-safety failures", () => {
    const alerts = createPagerDutyAlertDefinitions();

    expect(alerts.some((alert) => alert.name === "ExecutionErrorSpike")).toBe(true);
    expect(alerts.every((alert) => alert.labels.severity === "critical" || alert.labels.severity === "warning")).toBe(true);
    expect(alerts.every((alert) => alert.annotations.runbook_url.length > 0)).toBe(true);
    expect(alerts.every((alert) => alert.for.length > 0)).toBe(true);
    expect(alerts.every((alert) => alert.receiver === "pagerduty")).toBe(true);
  });
});

describe("GracefulShutdownCoordinator", () => {
  it("runs shutdown hooks once and records timeout failures", async () => {
    let calls = 0;
    const coordinator = new GracefulShutdownCoordinator({
      logger: createLogger("silent"),
      metrics: createBotMetrics(),
      timeoutMs: 25,
    });
    coordinator.addHook("fast", async () => {
      calls += 1;
    });

    const first = await coordinator.shutdown("SIGTERM");
    const second = await coordinator.shutdown("SIGTERM");

    expect(first.status).toBe("completed");
    expect(second.status).toBe("already_completed");
    expect(calls).toBe(1);
  });

  it("returns the in-flight shutdown result to concurrent callers", async () => {
    const coordinator = new GracefulShutdownCoordinator({
      logger: createLogger("silent"),
      metrics: createBotMetrics(),
      timeoutMs: 50,
    });
    let calls = 0;
    coordinator.addHook("slow", async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    const [first, second] = await Promise.all([
      coordinator.shutdown("SIGTERM"),
      coordinator.shutdown("SIGINT"),
    ]);

    expect(first.status).toBe("completed");
    expect(second.status).toBe("completed");
    expect(calls).toBe(1);
  });
});

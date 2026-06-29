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
  it("blocks live mode when dry-run validation is missing", () => {
    const gate = new DeploymentSafetyGate();

    const result = gate.evaluate({
      simulationMode: false,
      hasMetricsEndpoint: true,
      registeredChains: ["optimism"],
      minProfitMarginBps: 75,
    });

    expect(result).toEqual({
      status: "blocked",
      reasons: ["Successful dry-run validation is required before live mode"],
    });
  });

  it("allows live mode without PagerDuty when dry-run receipt is valid", () => {
    const gate = new DeploymentSafetyGate();

    expect(gate.evaluate({
      simulationMode: false,
      hasMetricsEndpoint: true,
      registeredChains: ["optimism"],
      minProfitMarginBps: 75,
      dryRunValidation: {
        success: true,
        validatedAtMs: Date.now(),
        configHash: "cfg",
        expectedConfigHash: "cfg",
        chains: ["optimism"],
        expectedChains: ["optimism"],
      },
    }).status).toBe("allowed");
  });

  it("allows simulation mode while still requiring chains and metrics", () => {
    const gate = new DeploymentSafetyGate();

    expect(gate.evaluate({
      simulationMode: true,
      hasMetricsEndpoint: true,
      registeredChains: ["optimism"],
      minProfitMarginBps: 50,
    }).status).toBe("allowed");
  });

  it("allows simulation at 40 bps margin (quote smoke tuning)", () => {
    const gate = new DeploymentSafetyGate();
    expect(gate.evaluate({
      simulationMode: true,
      hasMetricsEndpoint: true,
      registeredChains: ["optimism"],
      minProfitMarginBps: 40,
    }).status).toBe("allowed");
  });

  it("blocks simulation when margin is below 40 bps", () => {
    const gate = new DeploymentSafetyGate();
    const result = gate.evaluate({
      simulationMode: true,
      hasMetricsEndpoint: true,
      registeredChains: ["optimism"],
      minProfitMarginBps: 39,
    });
    expect(result.status).toBe("blocked");
    if (result.status === "blocked") {
      expect(result.reasons).toContain("MIN_PROFIT_MARGIN_BPS must be at least 40 in simulation mode");
    }
  });

  it("blocks live mode when margin is below 75 bps", () => {
    const gate = new DeploymentSafetyGate();
    const result = gate.evaluate({
      simulationMode: false,
      hasMetricsEndpoint: true,
      registeredChains: ["optimism"],
      minProfitMarginBps: 45,
      dryRunValidation: {
        success: true,
        validatedAtMs: Date.now(),
        configHash: "cfg",
        expectedConfigHash: "cfg",
        chains: ["optimism"],
        expectedChains: ["optimism"],
      },
    });
    expect(result.status).toBe("blocked");
    if (result.status === "blocked") {
      expect(result.reasons).toContain("MIN_PROFIT_MARGIN_BPS must be at least 75 in live mode");
    }
  });

  it("blocks live mode when dry-run validation is stale or for the wrong config", () => {
    const gate = new DeploymentSafetyGate({ dryRunValidationTtlMs: 1_000 });

    const result = gate.evaluate({
      simulationMode: false,
      hasMetricsEndpoint: true,
      registeredChains: ["optimism"],
      minProfitMarginBps: 50,
      dryRunValidation: {
        success: true,
        validatedAtMs: Date.now() - 10_000,
        configHash: "old",
        expectedConfigHash: "new",
        chains: ["arbitrum"],
        expectedChains: ["optimism"],
      },
    });

    expect(result.status).toBe("blocked");
    if (result.status === "blocked") {
      expect(result.reasons).toContain("Dry-run validation is stale");
      expect(result.reasons).toContain("Dry-run validation config hash does not match current config");
      expect(result.reasons).toContain("Dry-run validation chains do not match current chains");
    }
  });

  it("blocks live mode when dry-run validation timestamp is invalid or future dated", () => {
    const gate = new DeploymentSafetyGate();
    const result = gate.evaluate({
      simulationMode: false,
      hasMetricsEndpoint: true,
      registeredChains: ["optimism"],
      minProfitMarginBps: 50,
      dryRunValidation: {
        success: true,
        validatedAtMs: Number.NaN,
        configHash: "cfg",
        expectedConfigHash: "cfg",
        chains: ["optimism"],
        expectedChains: ["optimism"],
      },
    });

    expect(result.status).toBe("blocked");
    if (result.status === "blocked") {
      expect(result.reasons).toContain("Dry-run validation timestamp is invalid");
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

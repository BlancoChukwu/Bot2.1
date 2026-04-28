import { describe, expect, it } from "vitest";
import { createBotMetrics, createLogger } from "../../src/bot";
import { ConfigHotReloader, GracefulShutdownCoordinator } from "../../src/production/productionReadiness";

describe("production readiness chaos paths", () => {
  it("survives repeated bad hot reloads and applies the next valid config", () => {
    const reloader = new ConfigHotReloader({
      initialConfig: { pollIntervalMs: 400 },
      parse: (raw) => {
        const value = Number(raw);
        if (!Number.isFinite(value) || value <= 0) {
          throw new Error("pollIntervalMs must be positive");
        }
        return { pollIntervalMs: value };
      },
      logger: createLogger("silent"),
      metrics: createBotMetrics(),
    });

    expect(reloader.reload("bad").status).toBe("rejected");
    expect(reloader.reload("-1").status).toBe("rejected");
    expect(reloader.current()).toEqual({ pollIntervalMs: 400 });
    expect(reloader.reload("250").status).toBe("reloaded");
    expect(reloader.current()).toEqual({ pollIntervalMs: 250 });
  });

  it("times out slow shutdown hooks and still completes remaining hooks", async () => {
    const metrics = createBotMetrics();
    const coordinator = new GracefulShutdownCoordinator({
      logger: createLogger("silent"),
      metrics,
      timeoutMs: 5,
    });
    let fastHookRan = false;
    coordinator.addHook("slow", () => new Promise((resolve) => setTimeout(resolve, 50)));
    coordinator.addHook("fast", async () => {
      fastHookRan = true;
    });

    const result = await coordinator.shutdown("SIGTERM");

    expect(result.status).toBe("completed_with_errors");
    expect(result.errors).toEqual(["slow timed out"]);
    expect(fastHookRan).toBe(true);
    expect(metrics.snapshot().errorsTotal).toBe(1);
  });
});

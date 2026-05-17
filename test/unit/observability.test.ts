import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createBotMetrics, createLogger } from "../../src/bot";

class MemoryStream extends Writable {
  public readonly chunks: string[] = [];

  public override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(chunk.toString("utf8"));
    callback();
  }
}

describe("observability foundations", () => {
  it("writes structured pino logs with chain and opportunity context", () => {
    const destination = new MemoryStream();
    const logger = createLogger("info", {
      chain: "optimism",
      opportunityId: "op-123",
    }, destination);

    logger.info("opportunity_prechecked", { stage: "precheck" });

    const log = JSON.parse(destination.chunks.join("")) as {
      msg?: string;
      chain?: string;
      opportunityId?: string;
      stage?: string;
    };
    expect(log.msg).toBe("opportunity_prechecked");
    expect(log.chain).toBe("optimism");
    expect(log.opportunityId).toBe("op-123");
    expect(log.stage).toBe("precheck");
  });

  it("records chain-scoped latency histograms for critical bot stages", async () => {
    const metrics = createBotMetrics();

    metrics.recordLatency("scan", 0.125, { chain: "optimism" });

    const output = await metrics.registry.metrics();
    expect(output).toContain("bot_latency_seconds_bucket");
    expect(output).toContain('stage="scan"');
    expect(output).toContain('chain="optimism"');
  });

  it("records provider + flashblocks tagged pipeline latency histograms", async () => {
    const metrics = createBotMetrics();

    metrics.recordPipelineLatency("event_to_detection_ms", 87, {
      chain: "base",
      provider: "primary",
      flashblocks: "enabled",
    });

    const output = await metrics.registry.metrics();
    expect(output).toContain("pipeline_latency_ms_bucket");
    expect(output).toContain('stage="event_to_detection_ms"');
    expect(output).toContain('provider="primary"');
    expect(output).toContain('flashblocks="enabled"');
  });

  it("records provider scoring diagnostics metrics", async () => {
    const metrics = createBotMetrics();
    metrics.recordProviderRegret("best_fixed", "instantaneous", 0.12, { chain: "base" });
    metrics.recordProviderWeight(0.63, { chain: "base", provider: "primary" });
    metrics.recordProviderLossComponent("latency", 0.33, { chain: "base", provider: "primary" });
    metrics.recordProviderSelection({ chain: "base", provider: "primary", mode: "ftrl" });
    const output = await metrics.registry.metrics();
    expect(output).toContain("provider_scoring_regret");
    expect(output).toContain("provider_scoring_weight");
    expect(output).toContain("provider_scoring_loss_component_bucket");
    expect(output).toContain("provider_scoring_selection_total");
  });
});

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

  it("exposes Phase 1b watchlist gauges and counters on /metrics", async () => {
    const metrics = createBotMetrics();
    metrics.setWatchlistSize("base", 1482);
    metrics.setWatchlistLastUpdateAge("base", 12);
    metrics.setWatchlistCircuitBreakerOpen("base", false);
    metrics.recordWatchlistGapReplay("base");
    metrics.recordWatchlistStaleEvaluation("base", "stale");
    metrics.setProcessRssBytes(400_000_000);

    const output = await metrics.registry.metrics();
    expect(output).toContain("watchlist_size_total");
    expect(output).toContain("watchlist_last_update_age_seconds");
    expect(output).toContain("watchlist_circuit_breaker_open");
    expect(output).toContain("watchlist_gap_replay_total");
    expect(output).toContain("watchlist_stale_evaluations_total");
    expect(output).toContain("process_rss_bytes");
  });
});

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
});

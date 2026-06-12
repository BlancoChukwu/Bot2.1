import { describe, expect, it } from "vitest";
import { parseAavePoolLog, ingestionDedupKey } from "../../src/monitors/aaveEventParser";
import type { Log } from "viem";

describe("aaveEventParser", () => {
  it("dedup keys include block tx and log index", () => {
    const key = ingestionDedupKey({
      blockNumber: 10n,
      txHash: "0xabc",
      logIndex: 2,
      source: "pending",
    });
    expect(key).toBe("10:0xabc:2");
  });

  it("returns undefined for unrelated logs", () => {
    const log: Log = {
      address: "0x0000000000000000000000000000000000000001",
      blockHash: null,
      blockNumber: 1n,
      data: "0x",
      logIndex: 0,
      removed: false,
      topics: ["0xdeadbeef"],
      transactionHash: "0x1",
      transactionIndex: 0,
    };
    expect(parseAavePoolLog(log, {
      source: "pending",
      txHash: "0x1",
      logIndex: 0,
    })).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import { extractSubscriptionBlockNumber } from "../../src/monitors/flashblocksWsClient";

describe("extractSubscriptionBlockNumber", () => {
  it("parses newHeads header number field", () => {
    expect(
      extractSubscriptionBlockNumber({
        number: "0x2d42d5c",
        hash: "0xabc",
      }),
    ).toBe(47455788n);
  });

  it("parses newFlashblocks blockNumber field", () => {
    expect(
      extractSubscriptionBlockNumber({
        blockNumber: "47455788",
      }),
    ).toBe(47455788n);
  });

  it("parses bare hex string payloads", () => {
    expect(extractSubscriptionBlockNumber("0x2d42d5c")).toBe(47455788n);
  });

  it("returns undefined for unrecognized shapes", () => {
    expect(extractSubscriptionBlockNumber({ hash: "0xabc" })).toBeUndefined();
    expect(extractSubscriptionBlockNumber(null)).toBeUndefined();
  });
});

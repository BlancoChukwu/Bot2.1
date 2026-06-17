import { describe, expect, it } from "vitest";
import { extractSubscriptionBlockNumber } from "../../src/monitors/flashblocksWsClient";

describe("extractSubscriptionBlockNumber", () => {
  it("parses newHeads header number field", () => {
    const number = "0x2d3d65c";
    expect(
      extractSubscriptionBlockNumber({
        number,
        hash: "0xabc",
      }),
    ).toBe(BigInt(number));
  });

  it("parses newFlashblocks blockNumber field", () => {
    expect(
      extractSubscriptionBlockNumber({
        blockNumber: "47455788",
      }),
    ).toBe(47455788n);
  });

  it("parses bare hex string payloads", () => {
    const number = "0x2d3d65c";
    expect(extractSubscriptionBlockNumber(number)).toBe(BigInt(number));
  });

  it("returns undefined for unrecognized shapes", () => {
    expect(extractSubscriptionBlockNumber({ hash: "0xabc" })).toBeUndefined();
    expect(extractSubscriptionBlockNumber(null)).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import {
  collectPositionAssets,
  recordAssetDrift,
  topAssetDriftAttribution,
} from "../../src/monitors/shadowDriftAttribution";
import type { Address } from "viem";

describe("shadowDriftAttribution", () => {
  it("attributes drift to each non-zero position asset once per sample", () => {
    const buckets = new Map();
    const position = {
      collateral: new Map<string, bigint>([
        ["0x4200000000000000000000000000000000000006", 1_000n],
        ["0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", 500n],
      ]),
      debt: new Map<string, bigint>([
        ["0x4200000000000000000000000000000000000006", 0n],
      ]),
    };

    const assets = collectPositionAssets(position);
    expect(assets).toHaveLength(2);
    recordAssetDrift(buckets, assets, 120);
    recordAssetDrift(buckets, assets, 80);

    const top = topAssetDriftAttribution(buckets, 8);
    expect(top).toHaveLength(2);
    expect(top[0]?.meanDriftBps).toBe(100);
    expect(top[0]?.sampleCount).toBe(2);
    expect(top.map((row) => row.asset.toLowerCase())).toContain(
      "0x4200000000000000000000000000000000000006",
    );
    expect(top.map((row) => row.asset.toLowerCase())).toContain(
      "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" as Address,
    );
  });
});

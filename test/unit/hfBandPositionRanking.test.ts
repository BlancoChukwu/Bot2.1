import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import { listPositionsInHfBand } from "../../src/monitors/hfBandPositionRanking";
import type { LocalPositionModel, UserPosition } from "../../src/monitors/localPositionModel";

const WAD = 1_000_000_000_000_000_000n;

function fakeModel(rows: Array<{
  account: Address;
  hf: bigint;
  debtBase: bigint;
  seeded?: boolean;
}>): LocalPositionModel {
  const positions = new Map<string, UserPosition>();
  for (const row of rows) {
    positions.set(row.account.toLowerCase(), {
      account: row.account,
      isFullySeeded: row.seeded ?? true,
      cachedHfWad: row.hf,
      lastTotalDebtBase: row.debtBase,
      lastTotalCollateralBase: row.debtBase * 2n,
      collateral: new Map(),
      debt: new Map(),
      lastConfirmedBlock: 0n,
      seededAtBlock: 0n,
      lastActivityBlock: 0n,
      eModeCategoryId: 0,
    } as UserPosition);
  }
  return { positions } as LocalPositionModel;
}

describe("listPositionsInHfBand", () => {
  it("returns positions in band sorted by debtUsd descending without RPC", () => {
    const a = "0x0000000000000000000000000000000000000001" as Address;
    const b = "0x0000000000000000000000000000000000000002" as Address;
    const c = "0x0000000000000000000000000000000000000003" as Address;
    const model = fakeModel([
      { account: a, hf: 1_010_000_000_000_000_000n, debtBase: 10_000n * 10n ** 8n },
      { account: b, hf: 1_015_000_000_000_000_000n, debtBase: 50_000n * 10n ** 8n },
      { account: c, hf: 1_060_000_000_000_000_000n, debtBase: 100_000n * 10n ** 8n },
    ]);

    const rows = listPositionsInHfBand({
      model,
      hfMinWadInclusive: WAD,
      hfMaxWadInclusive: 1_020_000_000_000_000_000n,
    });

    expect(rows.map((r) => r.account)).toEqual([b, a]);
    expect(rows[0]?.debtUsd).toBe(50_000);
  });
});

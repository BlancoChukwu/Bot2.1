import { describe, expect, it, vi } from "vitest";
import type { Address } from "viem";
import { LiquidationCandidateGate } from "../../src/orchestrator/liquidationCandidateGate";
import { BorrowerCooldownRegistry } from "../../src/utils/borrowerCooldown";
import type { LiquidationCandidate } from "../../src/protocols/aaveV3";

const account = "0x00000000000000000000000000000000000000bb" as Address;
const debtAsset = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
const collateralAsset = "0x4200000000000000000000000000000000000006" as Address;

function candidate(debtToCover: bigint, repayValueUsd: number): LiquidationCandidate {
  return {
    account,
    collateralAsset,
    debtAsset,
    debtToCover,
    repayValueUsd,
    liquidationBonusBps: 500,
    healthFactor: 0n,
  };
}

describe("LiquidationCandidateGate", () => {
  it("drops dust candidates before enqueue", async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const gate = new LiquidationCandidateGate({
      minDebtUsd: 25,
      resolveGasCostUsd: async () => 5,
      borrowerCooldown: new BorrowerCooldownRegistry({ cooldownMs: 60_000, nowMs: () => 0 }),
      logger,
    });
    const filtered = await gate.filterCandidates("base", [
      candidate(1_000_000n, 1),
      candidate(50_000_000n, 50),
    ], "test");
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.repayValueUsd).toBe(50);
  });
});

export interface LiquidationEvInput {
  readonly repayValueUsd: number;
  readonly liquidationBonusBps: number;
  readonly gasCostUsd: number;
  readonly slippageBps: number;
  readonly minProfitUsd: number;
}

export interface LiquidationEv {
  readonly expectedProfitUsd: number;
  readonly isProfitable: boolean;
}

export interface LiquidationEV {
  readonly profitWei: bigint;
  readonly rawProfitWei: bigint;
  readonly gasCostWei: bigint;
  readonly slippageBufferWei: bigint;
  readonly isProfitable: boolean;
}

export const MIN_PROFIT_THRESHOLD_WEI = 10_000_000_000_000_000n;

const bpsDenominator = 10_000;
const bpsDenominatorWei = 10_000n;
const defaultSlippageBufferBps = 100n;

export function calculateLiquidationEV(
  debtToCover: bigint,
  collateralReceived: bigint,
  bonusPercentage: number,
  gasEstimate: bigint,
  gasPrice: bigint,
  minProfitThreshold = MIN_PROFIT_THRESHOLD_WEI,
): LiquidationEV {
  assertNonNegativeBigint("debtToCover", debtToCover);
  assertNonNegativeBigint("collateralReceived", collateralReceived);
  assertNonNegativeBigint("gasEstimate", gasEstimate);
  assertNonNegativeBigint("gasPrice", gasPrice);
  assertNonNegativeBigint("minProfitThreshold", minProfitThreshold);
  assertNonNegative("bonusPercentage", bonusPercentage);

  const bonusWei = (collateralReceived * BigInt(Math.trunc(bonusPercentage))) / bpsDenominatorWei;
  const gasCostWei = gasEstimate * gasPrice;
  const slippageBufferWei = (collateralReceived * defaultSlippageBufferBps) / bpsDenominatorWei;
  const rawProfitWei = bonusWei - gasCostWei - slippageBufferWei;
  const isProfitable = rawProfitWei >= minProfitThreshold;

  // Kelly sizing belongs at the capital allocator layer: cap exposure per liquidation
  // to protect the hot wallet from correlated bad fills and stale price assumptions.
  return {
    profitWei: isProfitable ? rawProfitWei : 0n,
    rawProfitWei,
    gasCostWei,
    slippageBufferWei,
    isProfitable,
  };
}

export function calculateLiquidationEv(input: LiquidationEvInput): LiquidationEv {
  assertNonNegative("repayValueUsd", input.repayValueUsd);
  assertNonNegative("liquidationBonusBps", input.liquidationBonusBps);
  assertNonNegative("gasCostUsd", input.gasCostUsd);
  assertNonNegative("slippageBps", input.slippageBps);
  assertNonNegative("minProfitUsd", input.minProfitUsd);

  const bonusUsd = input.repayValueUsd * (input.liquidationBonusBps / bpsDenominator);
  const slippageUsd = input.repayValueUsd * (input.slippageBps / bpsDenominator);
  const expectedProfitUsd = bonusUsd - input.gasCostUsd - slippageUsd;

  return {
    expectedProfitUsd,
    isProfitable: expectedProfitUsd >= input.minProfitUsd,
  };
}

function assertNonNegativeBigint(name: string, value: bigint): void {
  if (value < 0n) {
    throw new Error(`${name} must be a non-negative bigint`);
  }
}

function assertNonNegative(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative finite number`);
  }
}

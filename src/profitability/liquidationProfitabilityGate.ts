const defaultSafetyBuffer = 1.25;
const defaultLiquidationGasUnits = 420_000;
const defaultBonusBps = 500;
const defaultGasBufferMultiplier = 1.5;
const bpsScale = 10_000;

export interface LiquidationProfitabilityInput {
  readonly debtUsd: number;
  readonly liquidationBonusBps: number;
  readonly gasCostUsd: number;
  readonly flashFeeBps: number;
  readonly hardFloorUsd: number;
  readonly safetyBufferMultiplier?: number;
}

export interface LiquidationProfitabilityResult {
  readonly pass: boolean;
  readonly dynamicFloor: number;
  readonly hardFloor: number;
  readonly effectiveFloor: number;
  readonly gasCostUsd: number;
  readonly flashFeeUsd: number;
  readonly bonusRate: number;
  readonly netProfitUsd: number;
}

export function estimateLiquidationGasCostUsd(
  gasPriceWei: bigint,
  nativePriceUsd8: bigint,
  gasUnits: number = defaultLiquidationGasUnits,
  gasBufferMultiplier: number = defaultGasBufferMultiplier,
): number {
  if (nativePriceUsd8 <= 0n) {
    return 0;
  }
  const bufferedGasUnits = BigInt(Math.ceil(gasUnits * gasBufferMultiplier));
  const gasCostWei = gasPriceWei * bufferedGasUnits;
  return Number((gasCostWei * nativePriceUsd8) / 1_000_000_000_000_000_000n) / 1e8;
}

export function evaluateLiquidationProfitability(
  input: LiquidationProfitabilityInput,
): LiquidationProfitabilityResult {
  const bonusRate = input.liquidationBonusBps / bpsScale;
  const effectiveBonusRate = bonusRate > 0 ? bonusRate : defaultBonusBps / bpsScale;
  const flashFeeUsd = input.debtUsd * (input.flashFeeBps / bpsScale);
  const buffer = input.safetyBufferMultiplier ?? defaultSafetyBuffer;
  const dynamicFloor = ((input.gasCostUsd + flashFeeUsd) / effectiveBonusRate) * buffer;
  const hardFloor = input.hardFloorUsd;
  const effectiveFloor = Math.max(dynamicFloor, hardFloor);
  const estimatedBonus = input.debtUsd * effectiveBonusRate;
  const netProfitUsd = estimatedBonus - input.gasCostUsd - flashFeeUsd;

  return {
    pass: input.debtUsd >= effectiveFloor,
    dynamicFloor,
    hardFloor,
    effectiveFloor,
    gasCostUsd: input.gasCostUsd,
    flashFeeUsd,
    bonusRate: effectiveBonusRate,
    netProfitUsd,
  };
}

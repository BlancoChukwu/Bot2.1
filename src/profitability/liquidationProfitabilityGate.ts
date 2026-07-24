const defaultSafetyBuffer = 1.25;
const defaultLiquidationGasUnits = 420_000;
const defaultBonusBps = 500;
const defaultGasBufferMultiplier = 1.5;
const bpsScale = 10_000;
/** First-live conservative net profit floor (USD). */
export const DEFAULT_MIN_NET_PROFIT_USD = 45;
/** Require net profit ≥ this multiple of estimated gas USD. */
export const DEFAULT_MIN_NET_PROFIT_GAS_MULTIPLE = 2;

export interface LiquidationProfitabilityInput {
  readonly debtUsd: number;
  readonly liquidationBonusBps: number;
  readonly gasCostUsd: number;
  readonly flashFeeBps: number;
  readonly hardFloorUsd: number;
  readonly safetyBufferMultiplier?: number;
  /** Minimum acceptable net profit after gas + flash fee (default 45). */
  readonly minNetProfitUsd?: number;
  /** Net must also be ≥ this × gasCostUsd (default 2). */
  readonly minNetProfitGasMultiple?: number;
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
  readonly minNetProfitUsd: number;
  readonly netProfitFloorUsd: number;
  readonly netProfitPass: boolean;
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
  const minNetProfitUsd = input.minNetProfitUsd ?? DEFAULT_MIN_NET_PROFIT_USD;
  const gasMultiple = input.minNetProfitGasMultiple ?? DEFAULT_MIN_NET_PROFIT_GAS_MULTIPLE;
  const netProfitFloorUsd = Math.max(minNetProfitUsd, gasMultiple * input.gasCostUsd);
  const debtPass = input.debtUsd >= effectiveFloor;
  const netProfitPass = netProfitUsd >= netProfitFloorUsd;

  return {
    pass: debtPass && netProfitPass,
    dynamicFloor,
    hardFloor,
    effectiveFloor,
    gasCostUsd: input.gasCostUsd,
    flashFeeUsd,
    bonusRate: effectiveBonusRate,
    netProfitUsd,
    minNetProfitUsd,
    netProfitFloorUsd,
    netProfitPass,
  };
}

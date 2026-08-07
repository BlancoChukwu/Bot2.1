import { uncappedDebtUsdFromCapped } from "../config/closeFactor";

const defaultSafetyBuffer = 1.25;
const defaultLiquidationGasUnits = 420_000;
const defaultBonusBps = 500;
const defaultGasBufferMultiplier = 1.5;
const bpsScale = 10_000;
/** First-live conservative net profit floor (USD). */
export const DEFAULT_MIN_NET_PROFIT_USD = 45;
/** Require net profit ≥ this multiple of estimated gas USD. */
export const DEFAULT_MIN_NET_PROFIT_GAS_MULTIPLE = 2;
/** Soak epsilon for unexpected EV decision flips (USD). */
export const DEFAULT_EV_CAP_SOAK_EPSILON_USD = 0.01;

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

export interface CloseFactorEvComparison {
  readonly evUncapped: number;
  readonly evCapped: number;
  readonly evDeltaUsd: number;
  readonly uncappedPass: boolean;
  readonly cappedPass: boolean;
  readonly closeFactorBps: number;
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

/** Shared min-profit floor used by hot gate and prestage (do not duplicate). */
export function resolveMinNetProfitFloorUsd(
  gasCostUsd: number,
  minNetProfitUsd: number = DEFAULT_MIN_NET_PROFIT_USD,
  minNetProfitGasMultiple: number = DEFAULT_MIN_NET_PROFIT_GAS_MULTIPLE,
): number {
  return Math.max(minNetProfitUsd, minNetProfitGasMultiple * gasCostUsd);
}

/**
 * Side-by-side uncapped vs capped EV for soak instrumentation.
 * `cappedDebtUsd` must already be close-factor sized (SSoT). Gate decisions use capped only.
 */
export function compareCloseFactorEv(input: {
  readonly cappedDebtUsd: number;
  readonly closeFactorBps: number;
  readonly liquidationBonusBps: number;
  readonly gasCostUsd: number;
  readonly flashFeeBps: number;
  readonly hardFloorUsd: number;
  readonly minNetProfitUsd?: number;
  readonly minNetProfitGasMultiple?: number;
}): CloseFactorEvComparison & { readonly unexpectedAnomaly: boolean } {
  const uncappedDebtUsd = uncappedDebtUsdFromCapped(input.cappedDebtUsd, input.closeFactorBps);
  const base = {
    liquidationBonusBps: input.liquidationBonusBps,
    gasCostUsd: input.gasCostUsd,
    flashFeeBps: input.flashFeeBps,
    hardFloorUsd: input.hardFloorUsd,
    ...(input.minNetProfitUsd === undefined ? {} : { minNetProfitUsd: input.minNetProfitUsd }),
    ...(input.minNetProfitGasMultiple === undefined
      ? {}
      : { minNetProfitGasMultiple: input.minNetProfitGasMultiple }),
  };
  const capped = evaluateLiquidationProfitability({ ...base, debtUsd: input.cappedDebtUsd });
  const uncapped = evaluateLiquidationProfitability({ ...base, debtUsd: uncappedDebtUsd });
  const evDeltaUsd = uncapped.netProfitUsd - capped.netProfitUsd;
  // Expected: uncapped pass + capped fail on CF=5000 whales. Unexpected: capped pass / uncapped fail.
  const expectedCfFail = input.closeFactorBps === 5_000 && uncapped.pass && !capped.pass;
  const unexpectedAnomaly = (capped.pass !== uncapped.pass && !expectedCfFail)
    || (capped.pass && !uncapped.pass);

  return {
    evUncapped: uncapped.netProfitUsd,
    evCapped: capped.netProfitUsd,
    evDeltaUsd,
    uncappedPass: uncapped.pass,
    cappedPass: capped.pass,
    closeFactorBps: input.closeFactorBps,
    unexpectedAnomaly,
  };
}

/**
 * Aave V3 ReserveConfigurationMap bit layout (subset used for local HF).
 * LTV: bits 0–15, liquidation threshold: bits 16–31.
 * @see https://github.com/aave/aave-v3-core/blob/master/contracts/protocol/libraries/configuration/ReserveConfiguration.sol
 */

const LT_OFFSET = 16n;
const LT_MASK = 0xffffn;

/** Decode liquidation threshold in bps from a packed reserve configuration uint256. */
export function decodeLiquidationThresholdBps(configuration: bigint): bigint {
  return (configuration >> LT_OFFSET) & LT_MASK;
}

/** True when bit `reserveId` is set in an eMode collateral bitmap. */
export function isReserveEnabledOnBitmap(bitmap: bigint, reserveId: number): boolean {
  if (reserveId < 0 || reserveId > 127) {
    return false;
  }
  return ((bitmap >> BigInt(reserveId)) & 1n) === 1n;
}

export interface ParsedReserveConfigurationData {
  readonly liquidationThresholdBps: bigint;
  readonly liquidationBonus: bigint;
}

/** Parse PDP `getReserveConfigurationData` result (named object or positional tuple). */
export function parseReserveConfigurationData(
  result: unknown,
): ParsedReserveConfigurationData | undefined {
  if (typeof result === "object" && result !== null) {
    const record = result as {
      liquidationThreshold?: unknown;
      liquidationBonus?: unknown;
    };
    if (
      typeof record.liquidationThreshold === "bigint"
      && typeof record.liquidationBonus === "bigint"
    ) {
      return {
        liquidationThresholdBps: record.liquidationThreshold,
        liquidationBonus: record.liquidationBonus,
      };
    }
  }
  if (
    Array.isArray(result)
    && typeof result[2] === "bigint"
    && typeof result[3] === "bigint"
  ) {
    return {
      liquidationThresholdBps: result[2],
      liquidationBonus: result[3],
    };
  }
  return undefined;
}

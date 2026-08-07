import type { Address } from "viem";
import type { LocalPositionModel, UserPosition } from "./localPositionModel";

const BASE_CURRENCY_DECIMALS = 8;
const BASE_CURRENCY_SCALE = 10 ** BASE_CURRENCY_DECIMALS;

export interface HfBandPositionRow {
  readonly account: Address;
  readonly healthFactorWad: bigint;
  readonly debtUsd: number;
  readonly totalDebtBase: bigint;
  readonly totalCollateralBase: bigint | undefined;
  readonly collateralUsd: number | undefined;
}

export interface ListPositionsInHfBandInput {
  readonly model: LocalPositionModel;
  /** Inclusive lower bound (typically 1.0 WAD). */
  readonly hfMinWadInclusive: bigint;
  /** Inclusive upper bound (e.g. PRESTAGE_HF_UPPER). */
  readonly hfMaxWadInclusive: bigint;
  /** When true, only fully seeded positions are returned. Default true. */
  readonly fullySeededOnly?: boolean;
}

/**
 * No-RPC ranking helper: list warm-cache positions in an HF band sorted by debtUsd desc.
 */
export function listPositionsInHfBand(input: ListPositionsInHfBandInput): HfBandPositionRow[] {
  const fullySeededOnly = input.fullySeededOnly ?? true;
  const rows: HfBandPositionRow[] = [];
  for (const position of input.model.positions.values()) {
    if (fullySeededOnly && !position.isFullySeeded) {
      continue;
    }
    const hf = position.cachedHfWad;
    if (hf < input.hfMinWadInclusive || hf > input.hfMaxWadInclusive) {
      continue;
    }
    const debtBase = position.lastTotalDebtBase;
    if (debtBase === undefined || debtBase <= 0n) {
      continue;
    }
    rows.push(toBandRow(position, hf, debtBase));
  }
  rows.sort((a, b) => b.debtUsd - a.debtUsd);
  return rows;
}

function toBandRow(position: UserPosition, hf: bigint, debtBase: bigint): HfBandPositionRow {
  const collateralBase = position.lastTotalCollateralBase;
  return {
    account: position.account,
    healthFactorWad: hf,
    debtUsd: Number(debtBase) / BASE_CURRENCY_SCALE,
    totalDebtBase: debtBase,
    totalCollateralBase: collateralBase,
    collateralUsd: collateralBase === undefined
      ? undefined
      : Number(collateralBase) / BASE_CURRENCY_SCALE,
  };
}

import type { Address, PublicClient } from "viem";
import { aavePoolAbi } from "../protocols/aaveV3";
import type { BoundedWatchlist } from "./boundedWatchlist";

const WAD = 1_000_000_000_000_000_000n;
const DEFAULT_BATCH = 250;
const PRE_LIQUIDATABLE_WAD = 1_150_000_000_000_000_000n;

export interface LiquidatableAccount {
  readonly address: Address;
  readonly healthFactor: bigint;
  readonly totalDebtBase: bigint;
}

export interface HealthFactorSweepConfig {
  readonly client: PublicClient;
  readonly poolAddress: Address;
  readonly batchSize?: number;
  readonly minDebtBase?: bigint;
  /** When set, records HF for every successful read (enables low-tier every N blocks). */
  readonly watchlist?: BoundedWatchlist;
}

export async function sweepHealthFactors(
  addresses: readonly Address[],
  config: HealthFactorSweepConfig,
): Promise<LiquidatableAccount[]> {
  const batchSize = config.batchSize ?? DEFAULT_BATCH;
  const minDebt = config.minDebtBase ?? 0n;
  const liquidatable: LiquidatableAccount[] = [];

  for (let i = 0; i < addresses.length; i += batchSize) {
    const batch = addresses.slice(i, i + batchSize);
    const results = await config.client.multicall({
      contracts: batch.map((address) => ({
        address: config.poolAddress,
        abi: aavePoolAbi,
        functionName: "getUserAccountData",
        args: [address],
      })),
      allowFailure: true,
    });

    for (let j = 0; j < batch.length; j += 1) {
      const result = results[j];
      if (result?.status !== "success") {
        continue;
      }
      const data = result.result as unknown as readonly [bigint, bigint, bigint, bigint, bigint, bigint];
      const hf = data[5];
      const debt = data[1];
      const address = batch[j]!;
      config.watchlist?.updateHealthFactor(address, hf);
      if (hf < WAD && debt > minDebt) {
        liquidatable.push({
          address,
          healthFactor: hf,
          totalDebtBase: debt,
        });
      }
    }
  }

  return liquidatable;
}

export function filterAddressesForSweep(
  watchlist: BoundedWatchlist,
  currentBlock: bigint,
  lowTierEveryBlocks: bigint,
): Address[] {
  const highSignal: Address[] = [];
  const lowTier: Address[] = [];
  const runLowTier = lowTierEveryBlocks > 0n && currentBlock % lowTierEveryBlocks === 0n;

  for (const address of watchlist.addresses()) {
    const entry = watchlist.entries().get(address.toLowerCase());
    const hf = entry?.lastHealthFactor;
    if (hf === undefined || hf < PRE_LIQUIDATABLE_WAD) {
      highSignal.push(address as Address);
      continue;
    }
    if (runLowTier) {
      lowTier.push(address as Address);
    }
  }

  return [...highSignal, ...lowTier];
}

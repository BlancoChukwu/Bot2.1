import type { Address, PublicClient } from "viem";
import { aavePoolAbi } from "../protocols/aaveV3";
import { poolEmodeAbi } from "./aaveEmode";

const DEFAULT_BATCH = 200;

export interface ConfirmResult {
  readonly address: Address;
  readonly healthFactor: bigint;
  readonly totalDebtBase: bigint;
  readonly totalCollateralBase: bigint;
  readonly liquidationThreshold: bigint;
  readonly eModeCategoryId: number;
}

export interface TieredConfirmQueueConfig {
  readonly client: PublicClient;
  readonly poolAddress: Address;
  readonly batchSize?: number;
  readonly enableWatchTier: boolean;
}

export class TieredConfirmQueue {
  private readonly urgent = new Set<string>();
  private readonly watch = new Set<string>();

  public constructor(private readonly config: TieredConfirmQueueConfig) {}

  public enqueueUrgent(account: Address): void {
    this.urgent.add(account.toLowerCase());
  }

  public enqueueWatch(account: Address): void {
    if (!this.config.enableWatchTier) {
      return;
    }
    this.watch.add(account.toLowerCase());
  }

  public async flushUrgent(): Promise<readonly ConfirmResult[]> {
    if (this.urgent.size === 0) {
      return [];
    }
    const addresses = [...this.urgent].map((key) => key as Address);
    this.urgent.clear();
    return this.confirmBatch(addresses);
  }

  public async flushWatch(maxBatch = 50): Promise<readonly ConfirmResult[]> {
    if (!this.config.enableWatchTier || this.watch.size === 0) {
      return [];
    }
    const batch = [...this.watch].slice(0, maxBatch).map((key) => key as Address);
    for (const addr of batch) {
      this.watch.delete(addr.toLowerCase());
    }
    return this.confirmBatch(batch);
  }

  private async confirmBatch(addresses: readonly Address[]): Promise<ConfirmResult[]> {
    const batchSize = this.config.batchSize ?? DEFAULT_BATCH;
    const results: ConfirmResult[] = [];
    for (let i = 0; i < addresses.length; i += batchSize) {
      const batch = addresses.slice(i, i + batchSize);
      const accountResults = await this.config.client.multicall({
        contracts: batch.map((address) => ({
          address: this.config.poolAddress,
          abi: aavePoolAbi,
          functionName: "getUserAccountData",
          args: [address],
        })),
        allowFailure: true,
      });
      const emodeResults = await this.config.client.multicall({
        contracts: batch.map((address) => ({
          address: this.config.poolAddress,
          abi: poolEmodeAbi,
          functionName: "getUserEMode",
          args: [address],
        })),
        allowFailure: true,
      });
      for (let j = 0; j < batch.length; j += 1) {
        const address = batch[j]!;
        const row = accountResults[j];
        if (row?.status !== "success") {
          continue;
        }
        const data = row.result as unknown as readonly [bigint, bigint, bigint, bigint, bigint, bigint];
        const emode = emodeResults[j];
        results.push({
          address,
          healthFactor: data[5],
          totalDebtBase: data[1],
          totalCollateralBase: data[0],
          liquidationThreshold: data[3],
          eModeCategoryId: emode?.status === "success" ? Number(emode.result) : 0,
        });
      }
    }
    return results;
  }
}

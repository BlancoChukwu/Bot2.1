import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SupportedChain } from "../config/chains";
import type { LoggerLike } from "../bot";
import type { BootstrapDiscoverySource } from "./bootstrapTypes";
import type { ExportedBootstrapPosition, LocalPositionModel } from "./localPositionModel";

export const BOOTSTRAP_SNAPSHOT_VERSION = 1 as const;

export type BootstrapPositionSnapshot = ExportedBootstrapPosition;

export interface BootstrapSnapshotFile {
  readonly version: typeof BOOTSTRAP_SNAPSHOT_VERSION;
  readonly chain: SupportedChain;
  readonly discoverySource: BootstrapDiscoverySource;
  readonly savedAtMs: number;
  readonly blockNumber: string;
  readonly usersSeeded: number;
  readonly positions: readonly BootstrapPositionSnapshot[];
}

export interface BootstrapSnapshotStoreConfig {
  readonly chain: SupportedChain;
  readonly ttlHours: number;
  readonly diskPath?: string;
  readonly logger?: LoggerLike;
}

export class BootstrapSnapshotStore {
  private readonly filePath: string;

  public constructor(private readonly config: BootstrapSnapshotStoreConfig) {
    this.filePath = config.diskPath ?? `.cache/bootstrap-snapshot-${config.chain}.json`;
  }

  public async loadIfFresh(): Promise<BootstrapSnapshotFile | undefined> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as BootstrapSnapshotFile;
      if (parsed.version !== BOOTSTRAP_SNAPSHOT_VERSION || parsed.chain !== this.config.chain) {
        return undefined;
      }
      const ageMs = Date.now() - parsed.savedAtMs;
      const ttlMs = this.config.ttlHours * 3_600_000;
      if (ageMs > ttlMs) {
        this.config.logger?.info("bootstrap_snapshot_stale", {
          chain: this.config.chain,
          ageHours: ageMs / 3_600_000,
          ttlHours: this.config.ttlHours,
        });
        return undefined;
      }
      return parsed;
    } catch {
      return undefined;
    }
  }

  public async save(snapshot: BootstrapSnapshotFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(snapshot));
    this.config.logger?.info("bootstrap_snapshot_saved", {
      chain: this.config.chain,
      usersSeeded: snapshot.usersSeeded,
      path: this.filePath,
      discoverySource: snapshot.discoverySource,
    });
  }

  public applyToModel(model: LocalPositionModel, snapshot: BootstrapSnapshotFile): number {
    let seeded = 0;
    const blockNumber = BigInt(snapshot.blockNumber);
    for (const row of snapshot.positions) {
      model.seedFromOnChainSnapshot({
        account: row.account,
        blockNumber,
        eModeCategoryId: row.eModeCategoryId,
        healthFactorWad: BigInt(row.healthFactorWad),
        totalCollateralBase: BigInt(row.totalCollateralBase),
        totalDebtBase: BigInt(row.totalDebtBase),
        liquidationThreshold: BigInt(row.liquidationThreshold),
        reserves: row.reserves.map((reserve) => ({
          asset: reserve.asset,
          scaledCollateral: BigInt(reserve.scaledCollateral),
          scaledDebt: BigInt(reserve.scaledDebt),
        })),
      });
      seeded += 1;
    }
    return seeded;
  }
}

export function buildSnapshotFromModel(
  model: LocalPositionModel,
  input: {
    readonly chain: SupportedChain;
    readonly discoverySource: BootstrapDiscoverySource;
    readonly blockNumber: bigint;
  },
): BootstrapSnapshotFile {
  const positions = model.exportBootstrapSnapshots();
  return {
    version: BOOTSTRAP_SNAPSHOT_VERSION,
    chain: input.chain,
    discoverySource: input.discoverySource,
    savedAtMs: Date.now(),
    blockNumber: input.blockNumber.toString(),
    usersSeeded: positions.length,
    positions,
  };
}

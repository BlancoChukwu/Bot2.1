import {
  decodeEventLog,
  type Address,
  type Hex,
  type Log,
} from "viem";
import { aavePoolAbi } from "../protocols/aaveV3";

export type IngestionEventSource = "pending" | "confirmed" | "gap-fill";

export type AavePoolEventName =
  | "Supply"
  | "Withdraw"
  | "Borrow"
  | "Repay"
  | "LiquidationCall"
  | "ReserveDataUpdated";

export interface IngestionEventMeta {
  readonly blockNumber: bigint;
  readonly flashblockIndex?: number;
  readonly txHash: Hex;
  readonly logIndex: number;
  readonly source: IngestionEventSource;
}

export interface ParsedAavePoolEvent {
  readonly kind: "aave_pool";
  readonly name: AavePoolEventName;
  readonly meta: IngestionEventMeta;
  readonly reserve: Address;
  readonly collateralAsset?: Address;
  readonly debtAsset?: Address;
  readonly user?: Address;
  readonly onBehalfOf?: Address;
  readonly amount?: bigint;
  readonly debtToCover?: bigint;
  readonly liquidatedCollateralAmount?: bigint;
  readonly liquidityIndex?: bigint;
  readonly variableBorrowIndex?: bigint;
}

export interface ParsedChainlinkPriceEvent {
  readonly kind: "chainlink_price";
  readonly meta: IngestionEventMeta;
  readonly feed: Address;
  readonly asset: Address;
  readonly price: bigint;
  readonly oracleUpdatedAtSec: number;
}

export type ParsedIngestionEvent = ParsedAavePoolEvent | ParsedChainlinkPriceEvent;

export function ingestionDedupKey(meta: IngestionEventMeta): string {
  const flash = meta.flashblockIndex === undefined ? "" : `:${meta.flashblockIndex}`;
  return `${meta.blockNumber}${flash}:${meta.txHash}:${meta.logIndex}`;
}

export function rawLogToViemLog(raw: Record<string, unknown>): Log {
  const blockNumberRaw = raw.blockNumber;
  const blockNumber = typeof blockNumberRaw === "string"
    ? BigInt(blockNumberRaw)
    : typeof blockNumberRaw === "number"
      ? BigInt(blockNumberRaw)
      : 0n;
  return {
    address: (raw.address ?? "0x0000000000000000000000000000000000000000") as Address,
    blockHash: (raw.blockHash ?? null) as Hex | null,
    blockNumber,
    data: (raw.data ?? "0x") as Hex,
    logIndex: typeof raw.logIndex === "number"
      ? raw.logIndex
      : typeof raw.logIndex === "string"
        ? Number.parseInt(raw.logIndex, 16)
        : 0,
    removed: Boolean(raw.removed),
    topics: (raw.topics ?? []) as [`0x${string}`, ...`0x${string}`[]],
    transactionHash: (raw.transactionHash ?? "0x") as Hex,
    transactionIndex: typeof raw.transactionIndex === "number"
      ? raw.transactionIndex
      : 0,
  };
}

export function parseAavePoolLog(
  log: Log,
  meta: Omit<IngestionEventMeta, "blockNumber"> & { readonly blockNumber?: bigint },
): ParsedAavePoolEvent | undefined {
  const blockNumber = meta.blockNumber ?? log.blockNumber ?? 0n;
  const eventMeta: IngestionEventMeta = {
    blockNumber,
    txHash: (log.transactionHash ?? "0x") as Hex,
    logIndex: log.logIndex ?? 0,
    source: meta.source,
    ...(meta.flashblockIndex === undefined ? {} : { flashblockIndex: meta.flashblockIndex }),
  };

  for (const name of [
    "Supply",
    "Withdraw",
    "Borrow",
    "Repay",
    "LiquidationCall",
    "ReserveDataUpdated",
  ] as const) {
    try {
      const decoded = decodeEventLog({
        abi: aavePoolAbi,
        eventName: name,
        data: log.data,
        topics: log.topics,
      });
      const args = decoded.args as Record<string, unknown>;
      const reserve = (args.reserve ?? args.collateralAsset ?? args.debtAsset) as Address;
      return {
        kind: "aave_pool",
        name,
        meta: eventMeta,
        reserve,
        ...(name === "LiquidationCall"
          ? {
            collateralAsset: args.collateralAsset as Address,
            debtAsset: args.debtAsset as Address,
          }
          : {}),
        ...(args.user === undefined ? {} : { user: args.user as Address }),
        ...(args.onBehalfOf === undefined ? {} : { onBehalfOf: args.onBehalfOf as Address }),
        ...(args.amount === undefined ? {} : { amount: args.amount as bigint }),
        ...(args.debtToCover === undefined ? {} : { debtToCover: args.debtToCover as bigint }),
        ...(args.liquidatedCollateralAmount === undefined
          ? {} : { liquidatedCollateralAmount: args.liquidatedCollateralAmount as bigint }),
        ...(args.liquidityIndex === undefined ? {} : { liquidityIndex: args.liquidityIndex as bigint }),
        ...(args.variableBorrowIndex === undefined
          ? {} : { variableBorrowIndex: args.variableBorrowIndex as bigint }),
      };
    } catch {
      // try next event name
    }
  }
  return undefined;
}

const chainlinkAnswerUpdatedAbi = [
  {
    type: "event",
    name: "AnswerUpdated",
    inputs: [
      { name: "current", type: "int256", indexed: true },
      { name: "roundId", type: "uint256", indexed: true },
      { name: "updatedAt", type: "uint256", indexed: false },
    ],
  },
] as const;

export function parseChainlinkAnswerUpdatedLog(
  log: Log,
  asset: Address,
  meta: Omit<IngestionEventMeta, "blockNumber"> & { readonly blockNumber?: bigint },
): ParsedChainlinkPriceEvent | undefined {
  try {
    const decoded = decodeEventLog({
      abi: chainlinkAnswerUpdatedAbi,
      eventName: "AnswerUpdated",
      data: log.data,
      topics: log.topics,
    });
    const price = decoded.args.current as bigint;
    if (price <= 0n) {
      return undefined;
    }
    const updatedAtRaw = decoded.args.updatedAt;
    const oracleUpdatedAtSec = typeof updatedAtRaw === "bigint"
      ? Number(updatedAtRaw)
      : Number(updatedAtRaw);
    if (!Number.isFinite(oracleUpdatedAtSec) || oracleUpdatedAtSec <= 0) {
      return undefined;
    }
    const blockNumber = meta.blockNumber ?? log.blockNumber ?? 0n;
    return {
      kind: "chainlink_price",
      meta: {
        blockNumber,
        txHash: (log.transactionHash ?? "0x") as Hex,
        logIndex: log.logIndex ?? 0,
        source: meta.source,
        ...(meta.flashblockIndex === undefined ? {} : { flashblockIndex: meta.flashblockIndex }),
      },
      feed: log.address as Address,
      asset,
      price,
      oracleUpdatedAtSec,
    };
  } catch {
    return undefined;
  }
}

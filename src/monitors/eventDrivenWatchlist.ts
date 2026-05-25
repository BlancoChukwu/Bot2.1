import type { Address, Log, PublicClient } from "viem";
import type { BotMetrics, LoggerLike } from "../bot";
import type { SupportedChain } from "../config/chains";
import { aavePoolAbi } from "../protocols/aaveV3";
import type { BlockCursor } from "../utils/blockCursor";
import type { BoundedWatchlist } from "./boundedWatchlist";

const WATCHED_EVENT_NAMES = [
  "Borrow",
  "Repay",
  "Supply",
  "Withdraw",
  "LiquidationCall",
] as const;

const WATCHED_EVENTS = WATCHED_EVENT_NAMES.map((name) =>
  aavePoolAbi.find((item) => item.type === "event" && item.name === name),
).filter((item): item is (typeof aavePoolAbi)[number] => item !== undefined);

const DEFAULT_CHUNK = 2000n;
const DEFAULT_REORG_DEPTH = 10n;
const MAX_BACKOFF_MS = 2_000;
const MAX_RETRIES = 5;

export interface EventDrivenWatchlistConfig {
  readonly chain: SupportedChain;
  readonly poolAddress: Address;
  readonly readClient: PublicClient;
  readonly wsClient?: PublicClient;
  readonly watchlist: BoundedWatchlist;
  readonly cursor: BlockCursor;
  readonly logger: LoggerLike;
  readonly metrics?: BotMetrics;
  readonly onActivity?: () => void;
  readonly reorgSafeDepth?: bigint;
  readonly gapChunkBlocks?: bigint;
  readonly gapChunkDelayMs?: number;
  readonly coldStartLookbackBlocks?: bigint;
}

export class EventDrivenWatchlist {
  private readonly unwatchFns: Array<() => void> = [];
  private gapReplayInFlight = false;

  public constructor(private readonly config: EventDrivenWatchlistConfig) {}

  public async start(): Promise<void> {
    const lastBlock = await this.config.cursor.load();
    await this.replayGap(lastBlock);
    const client = this.config.wsClient ?? this.config.readClient;
    for (const eventName of WATCHED_EVENT_NAMES) {
      const unwatch = client.watchContractEvent({
        address: this.config.poolAddress,
        abi: aavePoolAbi,
        eventName,
        onLogs: (logs) => {
          void this.handleLogs(logs as readonly Log[]);
        },
        onError: (error) => {
          this.config.logger.warn("watchlist_ws_error", {
            chain: this.config.chain,
            error: String(error),
          });
          void this.replayGapFromCursor();
        },
      });
      this.unwatchFns.push(unwatch);
    }
  }

  public stop(): void {
    for (const unwatch of this.unwatchFns) {
      unwatch();
    }
    this.unwatchFns.length = 0;
  }

  public async coldStartFromLogs(lookbackBlocks: bigint): Promise<void> {
    const head = await this.config.readClient.getBlockNumber();
    const from = head > lookbackBlocks ? head - lookbackBlocks : 0n;
    await this.replayGap(from);
  }

  private async replayGapFromCursor(): Promise<void> {
    const lastBlock = await this.config.cursor.load();
    await this.replayGap(lastBlock);
  }

  private async replayGap(fromBlock: bigint): Promise<void> {
    if (this.gapReplayInFlight) {
      return;
    }
    this.gapReplayInFlight = true;
    try {
      const head = await this.config.readClient.getBlockNumber();
      const reorgDepth = this.config.reorgSafeDepth ?? DEFAULT_REORG_DEPTH;
      const safeHead = head > reorgDepth ? head - reorgDepth : 0n;
      if (fromBlock === 0n || safeHead <= fromBlock) {
        return;
      }
      const chunk = this.config.gapChunkBlocks ?? DEFAULT_CHUNK;
      this.config.logger.info("watchlist_gap_replay_start", {
        chain: this.config.chain,
        fromBlock: (fromBlock + 1n).toString(),
        toBlock: safeHead.toString(),
      });
      for (let from = fromBlock + 1n; from <= safeHead; from += chunk) {
        const to = from + chunk - 1n < safeHead ? from + chunk - 1n : safeHead;
        await this.fetchChunkWithBackoff(from, to);
        if (this.config.gapChunkDelayMs !== undefined && this.config.gapChunkDelayMs > 0) {
          await sleep(this.config.gapChunkDelayMs);
        }
      }
      this.config.logger.info("watchlist_gap_replay_complete", {
        chain: this.config.chain,
        safeHead: safeHead.toString(),
      });
      this.config.metrics?.recordWatchlistGapReplay(this.config.chain);
    } finally {
      this.gapReplayInFlight = false;
    }
  }

  private async fetchChunkWithBackoff(from: bigint, to: bigint): Promise<void> {
    let delayMs = 250;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
      try {
        const logs = await this.config.readClient.getLogs({
          address: this.config.poolAddress,
          events: [...WATCHED_EVENTS],
          fromBlock: from,
          toBlock: to,
        });
        await this.handleLogs(logs);
        return;
      } catch (error) {
        const message = String(error);
        const shrink = message.includes("response too large") || message.includes("limit");
        if (shrink && to > from) {
          const mid = from + (to - from) / 2n;
          await this.fetchChunkWithBackoff(from, mid);
          await this.fetchChunkWithBackoff(mid + 1n, to);
          return;
        }
        if (attempt === MAX_RETRIES - 1) {
          this.config.logger.error("watchlist_gap_replay_chunk_failed", {
            chain: this.config.chain,
            from: from.toString(),
            to: to.toString(),
            error: message,
          });
          throw error;
        }
        await sleep(delayMs);
        delayMs = Math.min(delayMs * 2, MAX_BACKOFF_MS);
      }
    }
  }

  private async handleLogs(logs: readonly Log[]): Promise<void> {
    if (logs.length === 0) {
      return;
    }
    const reorgDepth = this.config.reorgSafeDepth ?? DEFAULT_REORG_DEPTH;
    const head = await this.config.readClient.getBlockNumber();
    const safeHead = head > reorgDepth ? head - reorgDepth : 0n;
    let maxBlock = 0n;

    for (const log of logs) {
      const user = extractBorrowerFromLog(log);
      const blockNumber = log.blockNumber ?? 0n;
      if (user !== undefined && blockNumber > 0n) {
        this.config.watchlist.add(user, blockNumber);
      }
      if (blockNumber > maxBlock) {
        maxBlock = blockNumber;
      }
    }

    if (maxBlock > 0n && maxBlock <= safeHead) {
      await this.config.cursor.save(maxBlock);
    }
    this.config.onActivity?.();
  }
}

function extractBorrowerFromLog(log: Log): Address | undefined {
  const args = (log as Log & {
    readonly args?: {
      readonly user?: Address;
      readonly onBehalfOf?: Address;
    };
  }).args;
  const candidate = args?.user ?? args?.onBehalfOf;
  if (candidate === undefined) {
    return undefined;
  }
  return candidate;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

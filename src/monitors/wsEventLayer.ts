import type { Address, PublicClient } from "viem";
import { aavePoolAbi } from "../protocols/aaveV3";
import type { OracleFeedRegistry } from "../utils/priceOracleCache";
import type { SupportedChain } from "../config/chains";
import type { LoggerLike } from "../bot";
import type { BotMetrics } from "../bot";
import {
  FlashblocksWsClient,
} from "./flashblocksWsClient";
import {
  assertWsIngestionReady,
  buildWsIngestionSubscriptions,
  isResilientWsIngestionEnabled,
} from "./wsIngestionSubscriptions";
import {
  ingestionDedupKey,
  parseAavePoolLog,
  parseChainlinkAnswerUpdatedLog,
  rawLogToViemLog,
  type ParsedIngestionEvent,
} from "./aaveEventParser";
import type { PositionCheckpointStore } from "./positionCheckpointStore";

const DEFAULT_CHUNK = 2000n;
const MAX_DEDUP = 15_000;

export interface WsEventLayerConfig {
  readonly chain: SupportedChain;
  readonly poolAddress: Address;
  readonly ingestionWsUrl: string;
  readonly executionClient: PublicClient;
  readonly feedRegistry: OracleFeedRegistry;
  readonly checkpoint: PositionCheckpointStore;
  readonly logger: LoggerLike;
  readonly metrics?: BotMetrics;
  readonly bootstrapFromBlock?: bigint;
  readonly onEvent: (event: ParsedIngestionEvent) => void | Promise<void>;
  readonly onFlashblockTick: (blockNumber: bigint) => void | Promise<void>;
  readonly onGapFillComplete?: () => void;
}

export class WsEventLayer {
  private wsClient: FlashblocksWsClient | undefined;
  private readonly seen = new Set<string>();
  private seenOrder: string[] = [];
  private started = false;
  private lastFlashblockBlock = 0n;

  public constructor(private readonly config: WsEventLayerConfig) {}

  public async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;
    await this.runBootstrapOrGapFill();
    const resilient = isResilientWsIngestionEnabled();
    const feeds = this.config.feedRegistry[this.config.chain] ?? {};
    const subscriptions = buildWsIngestionSubscriptions({
      chain: this.config.chain,
      poolAddress: this.config.poolAddress,
      feedRegistry: this.config.feedRegistry,
      resilient,
    });

    this.wsClient = new FlashblocksWsClient({
      wsUrl: this.config.ingestionWsUrl,
      logger: this.config.logger,
      gracefulSubscribe: resilient,
      subscribeTimeoutMs: 15_000,
      onPendingLog: (raw) => {
        void this.handleRawLog(raw, "pending");
      },
      onConfirmedLog: (raw) => {
        void this.handleRawLog(raw, "confirmed");
      },
      onNewFlashblock: (payload) => {
        this.lastFlashblockBlock = payload.blockNumber;
        void this.config.onFlashblockTick(payload.blockNumber);
      },
      onDisconnect: () => {
        this.config.logger.warn("ws_event_layer_disconnected", { chain: this.config.chain });
      },
      onConnect: () => {
        void this.runBootstrapOrGapFill();
      },
    });
    const startResult = await this.wsClient.start(subscriptions);
    assertWsIngestionReady(startResult.activeRoles);
    this.config.logger.info("ws_event_layer_started", {
      chain: this.config.chain,
      ingestionWsUrl: redactUrl(this.config.ingestionWsUrl),
      chainlinkFeeds: Object.keys(feeds).length,
      resilientIngestion: resilient,
      activeSubscriptions: startResult.active,
      skippedSubscriptions: startResult.skipped,
    });
  }

  public stop(): void {
    this.started = false;
    this.wsClient?.stop();
    this.wsClient = undefined;
  }

  private async runBootstrapOrGapFill(): Promise<void> {
    const last = await this.config.checkpoint.loadLastProcessedBlock();
    const head = await this.config.executionClient.getBlockNumber();
    const from = last > 0n ? last + 1n : (this.config.bootstrapFromBlock ?? 0n);
    if (from > head) {
      return;
    }
    this.config.logger.info("ws_event_layer_gap_fill_start", {
      chain: this.config.chain,
      from: from.toString(),
      to: head.toString(),
    });
    const events = aavePoolAbi.filter((item) => item.type === "event");
    for (let chunkFrom = from; chunkFrom <= head; chunkFrom += DEFAULT_CHUNK) {
      const chunkTo = chunkFrom + DEFAULT_CHUNK - 1n < head ? chunkFrom + DEFAULT_CHUNK - 1n : head;
      const logs = await this.config.executionClient.getLogs({
        address: this.config.poolAddress,
        events: [...events],
        fromBlock: chunkFrom,
        toBlock: chunkTo,
      });
      for (const log of logs) {
        await this.handleViemLog(log, "gap-fill");
      }
      await this.config.checkpoint.saveLastProcessedBlock(chunkTo);
    }
    this.config.metrics?.recordWatchlistGapReplay(this.config.chain);
    this.config.onGapFillComplete?.();
    this.config.logger.info("ws_event_layer_gap_fill_complete", { chain: this.config.chain, head: head.toString() });
  }

  private async handleRawLog(raw: Record<string, unknown>, source: "pending" | "confirmed"): Promise<void> {
    const log = rawLogToViemLog(raw);
    await this.handleViemLog(log, source);
  }

  private async handleViemLog(
    log: import("viem").Log,
    source: "pending" | "confirmed" | "gap-fill",
  ): Promise<void> {
    const blockNumber = log.blockNumber ?? this.lastFlashblockBlock;
    const meta = {
      blockNumber,
      txHash: (log.transactionHash ?? "0x") as `0x${string}`,
      logIndex: log.logIndex ?? 0,
      source,
    };
    if (!this.markSeen(meta)) {
      return;
    }

    const poolEvent = parseAavePoolLog(log, meta);
    if (poolEvent !== undefined) {
      await this.config.onEvent(poolEvent);
      if (source !== "pending" && blockNumber > 0n) {
        await this.config.checkpoint.saveLastProcessedBlock(blockNumber);
      }
      return;
    }

    const feeds = this.config.feedRegistry[this.config.chain] ?? {};
    for (const [assetKey, feedConfig] of Object.entries(feeds)) {
      if (feedConfig?.feed === undefined || log.address?.toLowerCase() !== feedConfig.feed.toLowerCase()) {
        continue;
      }
      const priceEvent = parseChainlinkAnswerUpdatedLog(log, assetKey as Address, meta);
      if (priceEvent !== undefined) {
        await this.config.onEvent(priceEvent);
      }
    }
  }

  private markSeen(meta: {
    readonly blockNumber: bigint;
    readonly txHash: `0x${string}`;
    readonly logIndex: number;
    readonly source: "pending" | "confirmed" | "gap-fill";
  }): boolean {
    const key = ingestionDedupKey(meta);
    if (this.seen.has(key)) {
      return false;
    }
    this.seen.add(key);
    this.seenOrder.push(key);
    if (this.seenOrder.length > MAX_DEDUP) {
      const evict = this.seenOrder.shift();
      if (evict !== undefined) {
        this.seen.delete(evict);
      }
    }
    return true;
  }
}

function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}/...`;
  } catch {
    return "invalid-url";
  }
}

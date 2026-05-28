import type { Address, PublicClient } from "viem";
import {
  AERODROME_CLASSIC_SWAP_EVENT,
  CL_SWAP_EVENT,
} from "../config/ammEventTopics";
import type { BotMetrics, LoggerLike } from "../bot";
import type { SupportedChain } from "../config/chains";
import { getAmmMirror } from "./ammMirror";

export interface AmmMirrorLogSourceConfig {
  readonly chain: SupportedChain;
  readonly pools: readonly Address[];
  readonly wsClient: PublicClient;
  readonly logger: LoggerLike;
  readonly metrics?: BotMetrics;
}

/**
 * Subscribes to concentrated-liquidity + Aerodrome classic Swap logs on monitored pools.
 * Feeds {@link AmmMirror} sqrt price state for local quote paths.
 */
export class AmmMirrorLogSource {
  private readonly stopFns: Array<() => void> = [];

  public constructor(private readonly config: AmmMirrorLogSourceConfig) {}

  public start(): void {
    if (this.config.pools.length === 0) {
      this.config.logger.warn("amm_mirror_log_source_no_pools", { chain: this.config.chain });
      return;
    }
    const mirror = getAmmMirror();
    for (const pool of this.config.pools) {
      const stopCl = this.config.wsClient.watchContractEvent?.({
        address: pool,
        abi: [CL_SWAP_EVENT],
        eventName: "Swap",
        onLogs: (logs) => {
          for (const log of logs) {
            const args = log.args as {
              readonly sqrtPriceX96?: bigint;
              readonly liquidity?: bigint;
              readonly tick?: number;
            };
            if (args.sqrtPriceX96 === undefined) {
              continue;
            }
            mirror.upsert({
              pool,
              sqrtPriceX96: args.sqrtPriceX96,
              liquidity: args.liquidity ?? 0n,
              tick: args.tick ?? 0,
              updatedAtMs: Date.now(),
            });
          }
          this.config.metrics?.recordPipelineLatency("event_to_detection_ms", logs.length, {
            chain: this.config.chain,
            provider: "amm_mirror_cl",
            flashblocks: "disabled",
          });
        },
        onError: (error) => {
          this.config.logger.warn("amm_mirror_cl_swap_subscribe_error", {
            chain: this.config.chain,
            pool,
            error: String(error),
          });
        },
      });
      if (stopCl !== undefined) {
        this.stopFns.push(stopCl);
      }

      const stopClassic = this.config.wsClient.watchContractEvent?.({
        address: pool,
        abi: [AERODROME_CLASSIC_SWAP_EVENT],
        eventName: "Swap",
        onLogs: (logs) => {
          mirror.recordSwapEvent();
          this.config.metrics?.recordPipelineLatency("event_to_detection_ms", logs.length, {
            chain: this.config.chain,
            provider: "amm_mirror_classic",
            flashblocks: "disabled",
          });
        },
        onError: (error) => {
          this.config.logger.warn("amm_mirror_classic_swap_subscribe_error", {
            chain: this.config.chain,
            pool,
            error: String(error),
          });
        },
      });
      if (stopClassic !== undefined) {
        this.stopFns.push(stopClassic);
      }
    }
    this.config.logger.info("amm_mirror_log_source_started", {
      chain: this.config.chain,
      poolCount: this.config.pools.length,
      pools: this.config.pools,
    });
  }

  public stop(): void {
    for (const stop of this.stopFns) {
      stop();
    }
    this.stopFns.length = 0;
  }
}

export function parseMirrorPoolAddresses(raw: string | undefined): Address[] {
  if (raw === undefined || raw.trim().length === 0) {
    return [];
  }
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => /^0x[a-fA-F0-9]{40}$/.test(part)) as Address[];
}

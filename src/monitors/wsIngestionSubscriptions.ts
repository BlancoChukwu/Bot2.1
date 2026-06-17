import type { Address } from "viem";
import type { SupportedChain } from "../config/chains";
import type { OracleFeedRegistry } from "../utils/priceOracleCache";
import {
  aavePoolConfirmedLogsFilter,
  aavePoolPendingLogsFilter,
  chainlinkLogsFilter,
  type FlashblocksSubscriptionKind,
} from "./flashblocksWsClient";

export interface WsIngestionSubscription {
  readonly kind: FlashblocksSubscriptionKind;
  readonly params?: Record<string, unknown>;
  readonly role: "pending_pool" | "confirmed_pool" | "flashblock_clock" | "block_clock" | "chainlink";
}

export function isResilientWsIngestionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const budget = (env.RPC_BUDGET_MODE ?? "").trim().toLowerCase();
  if (budget === "1" || budget === "true" || budget === "yes" || budget === "on") {
    return true;
  }
  const graceful = (env.WS_INGESTION_GRACEFUL ?? "").trim().toLowerCase();
  return graceful === "1" || graceful === "true" || graceful === "yes" || graceful === "on";
}

export function buildWsIngestionSubscriptions(input: {
  readonly chain: SupportedChain;
  readonly poolAddress: Address;
  readonly feedRegistry: OracleFeedRegistry;
  readonly resilient: boolean;
}): WsIngestionSubscription[] {
  const subscriptions: WsIngestionSubscription[] = [
    { kind: "pendingLogs", params: aavePoolPendingLogsFilter(input.poolAddress), role: "pending_pool" },
  ];
  if (input.resilient) {
    subscriptions.push({
      kind: "logs",
      params: aavePoolConfirmedLogsFilter(input.poolAddress),
      role: "confirmed_pool",
    });
    subscriptions.push({ kind: "newHeads", role: "block_clock" });
  }
  subscriptions.push({ kind: "newFlashblocks", role: "flashblock_clock" });

  const feeds = input.feedRegistry[input.chain] ?? {};
  for (const [asset, feedConfig] of Object.entries(feeds)) {
    if (feedConfig?.feed === undefined) {
      continue;
    }
    subscriptions.push({
      kind: "logs",
      params: chainlinkLogsFilter(feedConfig.feed),
      role: "chainlink",
    });
    void asset;
  }
  return subscriptions;
}

export function assertWsIngestionReady(activeRoles: readonly string[]): void {
  const roles = new Set(activeRoles);
  const hasIngestion = roles.has("pending_pool") || roles.has("confirmed_pool");
  const hasClock = roles.has("flashblock_clock") || roles.has("block_clock");
  if (!hasIngestion) {
    throw new Error("WS ingestion requires pendingLogs or confirmed pool logs subscription");
  }
  if (!hasClock) {
    throw new Error("WS ingestion requires newFlashblocks or newHeads subscription");
  }
}

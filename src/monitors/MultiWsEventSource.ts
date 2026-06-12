import type { Address } from "viem";
import { createFailoverPublicClient, createChainWebSocketPublicClient, type SupportedChain } from "../config/chains";
import type { ChainRegistry } from "../config/chainRegistry";
import { aavePoolAbi } from "../protocols/aaveV3";
import type { BotMetrics, LoggerLike } from "../bot";
import type { DetectionEventHandlers, DetectionEventSource } from "./hybridDetectionPipeline";
import { BayesianHazardModel, FtrlOpportunityRanker } from "../optimization/hazardPrediction";
import { FixedSizeDedupe } from "../utils/fixedSizeDedupe";
import { extractBorrowerAddressesFromLog } from "./borrowerLogExtract";

const trackedEvents = ["ReserveDataUpdated", "Borrow", "Supply", "Repay", "Withdraw", "LiquidationCall"] as const;
type TrackedEventName = (typeof trackedEvents)[number];
const defaultHeartbeatTimeoutMs = 30_000;
const defaultMaxReconnectDelayMs = 30_000;
const providerPromoteIntervalMs = 30_000;
const dedupeCapacity = 1_000;

interface ProviderState {
  readonly name: string;
  readonly wsUrl: string;
  score: number;
  eventCount: number;
  missedOpportunities: number;
  lastEventToDetectionMs: number;
  lastGetLogsMs: number;
  lastFlashblockLeadMs: number;
}

export interface MultiWsEventSourceConfig {
  readonly registry: ChainRegistry;
  readonly chain: SupportedChain;
  readonly logger: LoggerLike;
  readonly metrics: BotMetrics;
  readonly onBlock?: (blockNumber: bigint) => void;
  readonly onBorrowerAccounts?: (accounts: readonly Address[]) => void | Promise<void>;
  readonly heartbeatTimeoutMs?: number;
  readonly maxReconnectDelayMs?: number;
}

export class MultiWsEventSource implements DetectionEventSource {
  private readonly dedupe = new FixedSizeDedupe(dedupeCapacity);
  // Ancillary metadata should not retain objects beyond log handling.
  private readonly logMeta = new WeakMap<object, { receivedAtMs: number }>();
  private readonly providerStates = new Map<string, ProviderState>();
  private readonly stopFns: Array<() => void> = [];
  private readonly providerStopFns = new Map<string, Array<() => void>>();
  private readonly reconnectTimers: NodeJS.Timeout[] = [];
  private readonly wsClients: unknown[] = [];
  private readonly readClient;
  private readonly model = new BayesianHazardModel();
  private readonly ftrl = new FtrlOpportunityRanker({ model: this.model });
  private readonly reconnectAttemptByProvider = new Map<string, number>();
  private readonly heartbeatByProvider = new Map<string, number>();
  private readonly endpointUrls: Array<{ readonly name: string; readonly wsUrl: string }> = [];
  private promoteTimer: NodeJS.Timeout | undefined;
  private activeHandlers: DetectionEventHandlers | undefined;
  private primaryProviderName = "primary";

  public constructor(private readonly config: MultiWsEventSourceConfig) {
    const entry = config.registry.get(config.chain);
    this.readClient = createFailoverPublicClient({
      chain: config.chain,
      rpcUrl: entry.execution.httpPrimary,
      fallbackRpcUrls: entry.execution.fallbacks,
    });
  }

  public async start(handlers: DetectionEventHandlers): Promise<() => void> {
    const endpoints = this.wsEndpoints();
    this.endpointUrls.splice(0, this.endpointUrls.length, ...endpoints);
    if (endpoints.length === 0) {
      throw new Error("MultiWsEventSource requires at least one detection websocket endpoint");
    }
    this.activeHandlers = handlers;
    for (const endpoint of endpoints) {
      this.providerStates.set(endpoint.name, {
        ...endpoint,
        score: 0,
        eventCount: 0,
        missedOpportunities: 0,
        lastEventToDetectionMs: 0,
        lastGetLogsMs: 0,
        lastFlashblockLeadMs: 0,
      });
      this.seedProvider(endpoint.name);
      this.subscribeProvider(
        endpoint.name,
        endpoint.wsUrl,
        handlers,
        endpoint.name === this.primaryProviderName,
      );
    }
    this.promoteTimer = setInterval(() => {
      this.promoteBestProvider();
    }, providerPromoteIntervalMs);
    this.promoteTimer.unref?.();
    return () => this.stopAll();
  }

  private promoteBestProvider(): void {
    if (this.providerStates.size <= 1 || this.activeHandlers === undefined) {
      return;
    }
    const ranked = [...this.providerStates.values()]
      .sort((left, right) => {
        const leftLead = left.lastFlashblockLeadMs > 0 ? left.lastFlashblockLeadMs : 9_999;
        const rightLead = right.lastFlashblockLeadMs > 0 ? right.lastFlashblockLeadMs : 9_999;
        if (left.score !== right.score) {
          return right.score - left.score;
        }
        if (leftLead !== rightLead) {
          return leftLead - rightLead;
        }
        return right.eventCount - left.eventCount;
      });
    const best = ranked[0];
    if (best === undefined || best.name === this.primaryProviderName) {
      return;
    }
    const previous = this.primaryProviderName;
    this.primaryProviderName = best.name;
    this.config.logger.info("ws_provider_promoted", {
      chain: this.config.chain,
      previous,
      promoted: best.name,
      score: best.score,
      lastFlashblockLeadMs: best.lastFlashblockLeadMs,
      eventCount: best.eventCount,
    });
    for (const endpoint of this.endpointUrls) {
      this.stopProviderSubscriptions(endpoint.name);
      this.subscribeProvider(
        endpoint.name,
        endpoint.wsUrl,
        this.activeHandlers,
        endpoint.name === this.primaryProviderName,
      );
    }
  }

  private wsEndpoints(): Array<{ readonly name: string; readonly wsUrl: string }> {
    const detection = this.config.registry.get(this.config.chain).detection;
    return [
      detection.wsPrimary === undefined ? undefined : { name: "primary", wsUrl: detection.wsPrimary },
      detection.wsSecondary === undefined ? undefined : { name: "secondary", wsUrl: detection.wsSecondary },
      detection.wsTertiary === undefined ? undefined : { name: "tertiary", wsUrl: detection.wsTertiary },
    ].filter((entry): entry is { readonly name: string; readonly wsUrl: string } => entry !== undefined);
  }

  private subscribeProvider(
    providerName: string,
    wsUrl: string,
    handlers: DetectionEventHandlers,
    isPrimary = false,
  ): void {
    this.stopProviderSubscriptions(providerName);
    const chainEntry = this.config.registry.get(this.config.chain);
    const poolAddress = this.config.registry.getResolvedAave(this.config.chain).pool;
    const flashblocks = chainEntry.detection.flashblocksEnabled ? "enabled" : "disabled";
    const wsClient = createChainWebSocketPublicClient({ chain: this.config.chain, wsRpcUrl: wsUrl });
    this.wsClients.push(wsClient);
    for (const eventName of trackedEvents) {
      const stop = wsClient.watchContractEvent?.({
        address: poolAddress,
        abi: aavePoolAbi,
        eventName,
        onLogs: async (logs) => {
          this.heartbeatByProvider.set(providerName, Date.now());
          await this.handleLogs(providerName, eventName, logs, handlers);
        },
        onError: (error) => {
          const state = this.providerStates.get(providerName);
          if (state !== undefined) {
            state.missedOpportunities += 1;
            state.score -= 2;
            this.ftrl.observe({
              chain: this.config.chain,
              opportunityId: `${providerName}:ws_error:${Date.now()}`,
              features: [`provider:${providerName}`, "signal:ws_error"],
              expectedProfitBps: 100,
              outcome: "missed",
            });
          }
          handlers.onError(this.config.chain, error);
          this.scheduleReconnect(providerName, wsUrl, handlers);
        },
      });
      if (stop !== undefined) {
        this.stopFns.push(stop);
        const scoped = this.providerStopFns.get(providerName) ?? [];
        scoped.push(stop);
        this.providerStopFns.set(providerName, scoped);
      }
    }
    const flashblocksEnabled = this.config.registry.get(this.config.chain).detection.flashblocksEnabled;
    if (flashblocksEnabled) {
      const stopFlash = wsClient.watchBlockNumber?.({
        onBlockNumber: (blockNumber) => {
          this.heartbeatByProvider.set(providerName, Date.now());
          const state = this.providerStates.get(providerName);
          if (state !== undefined) {
            state.lastFlashblockLeadMs = 1;
            state.score += 1;
            this.config.metrics.recordPipelineLatency("flashblocks_lead_ms", 1, {
              chain: this.config.chain,
              provider: providerName,
              flashblocks,
            });
          }
          void blockNumber;
        },
        onError: (error) => handlers.onError(this.config.chain, error),
      });
      if (stopFlash !== undefined) {
        this.stopFns.push(stopFlash);
        const scoped = this.providerStopFns.get(providerName) ?? [];
        scoped.push(stopFlash);
        this.providerStopFns.set(providerName, scoped);
      }
    }
    if (isPrimary && this.config.onBlock !== undefined) {
      const stopHeads = wsClient.watchBlockNumber?.({
        onBlockNumber: (blockNumber) => {
          this.heartbeatByProvider.set(providerName, Date.now());
          this.config.onBlock?.(blockNumber);
        },
        onError: (error) => handlers.onError(this.config.chain, error),
      });
      if (stopHeads !== undefined) {
        this.stopFns.push(stopHeads);
        const scoped = this.providerStopFns.get(providerName) ?? [];
        scoped.push(stopHeads);
        this.providerStopFns.set(providerName, scoped);
      }
    }
    const heartbeatTimer = setInterval(() => {
      const last = this.heartbeatByProvider.get(providerName) ?? 0;
      const elapsed = Date.now() - last;
      const heartbeatTimeoutMs = this.config.heartbeatTimeoutMs ?? defaultHeartbeatTimeoutMs;
      if (elapsed < heartbeatTimeoutMs) {
        return;
      }
      this.config.logger.warn("ws_heartbeat_missed", {
        chain: this.config.chain,
        provider: providerName,
        elapsedMs: elapsed,
      });
      this.scheduleReconnect(providerName, wsUrl, handlers);
    }, this.config.heartbeatTimeoutMs ?? defaultHeartbeatTimeoutMs);
    heartbeatTimer.unref?.();
    this.reconnectTimers.push(heartbeatTimer);
  }

  private scheduleReconnect(providerName: string, wsUrl: string, handlers: DetectionEventHandlers): void {
    const attempts = (this.reconnectAttemptByProvider.get(providerName) ?? 0) + 1;
    this.reconnectAttemptByProvider.set(providerName, attempts);
    const maxReconnectDelayMs = this.config.maxReconnectDelayMs ?? defaultMaxReconnectDelayMs;
    const baseDelay = Math.min(500 * (2 ** (attempts - 1)), maxReconnectDelayMs);
    const jitter = Math.floor(Math.random() * 250);
    const timer = setTimeout(() => {
      this.stopProviderSubscriptions(providerName);
      const alternate = this.pickAlternateEndpoint(providerName, wsUrl);
      this.reconnectAttemptByProvider.set(providerName, 0);
      this.subscribeProvider(alternate.name, alternate.wsUrl, handlers, alternate.name === "primary");
    }, baseDelay + jitter);
    this.reconnectTimers.push(timer);
  }

  private async handleLogs(
    providerName: string,
    eventName: TrackedEventName,
    logs: readonly unknown[],
    handlers: DetectionEventHandlers,
  ): Promise<void> {
    const provider = this.providerStates.get(providerName);
    const receivedAt = Date.now();
    const flashblocks = this.config.registry.get(this.config.chain).detection.flashblocksEnabled
      ? "enabled"
      : "disabled";
    if (provider === undefined) {
      return;
    }

    for (const log of logs) {
      const shaped = log as {
        readonly blockHash?: string;
        readonly transactionHash?: string;
        readonly logIndex?: number;
        readonly blockNumber?: bigint;
        readonly args?: { readonly reserve?: Address };
      };
      const reserve = shaped.args?.reserve;
      if (eventName === "Borrow" || eventName === "LiquidationCall" || eventName === "Repay") {
        const borrowers = extractBorrowerAddressesFromLog(shaped as never);
        if (borrowers.length > 0) {
          void this.config.onBorrowerAccounts?.(borrowers);
        }
      }
      if (reserve === undefined) {
        continue;
      }
      const dedupeKey = `${shaped.transactionHash ?? "na"}-${String(shaped.logIndex ?? "na")}`;
      this.logMeta.set(shaped as object, { receivedAtMs: receivedAt });
      if (!this.dedupe.add(dedupeKey)) {
        continue;
      }
      provider.eventCount += 1;
      provider.lastEventToDetectionMs = Math.max(1, Date.now() - receivedAt);
      provider.score += 1 + this.ftrlBoost(providerName);
      handlers.onReserveUpdated({ chain: this.config.chain, reserve });

      const blockNumber = shaped.blockNumber;
      if (blockNumber !== undefined) {
        const started = Date.now();
        try {
          await this.readClient.getLogs({
            address: this.config.registry.getResolvedAave(this.config.chain).pool,
            fromBlock: blockNumber,
            toBlock: blockNumber,
          });
          provider.lastGetLogsMs = Date.now() - started;
          provider.score += provider.lastGetLogsMs <= 100 ? 0.5 : -0.5;
        } catch {
          provider.score -= 1;
        }
      }
      this.config.metrics.recordLatency("scan", provider.lastEventToDetectionMs / 1_000, { chain: `${this.config.chain}:${providerName}` });
      this.config.metrics.recordPipelineLatency("event_to_detection_ms", provider.lastEventToDetectionMs, {
        chain: this.config.chain,
        provider: providerName,
        flashblocks,
      });
      this.config.logger.info("multi_ws_event_detected", {
        chain: this.config.chain,
        provider: providerName,
        eventName,
        event_to_detection_ms: provider.lastEventToDetectionMs,
        eth_getLogs_ms: provider.lastGetLogsMs,
        flashblocks_lead_ms: provider.lastFlashblockLeadMs,
        score: provider.score,
      });
      this.ftrl.observe({
        chain: this.config.chain,
        opportunityId: `${providerName}:${dedupeKey}`,
        features: [`provider:${providerName}`, `event:${eventName}`],
        expectedProfitBps: 100,
        outcome: "won",
      });
    }

    const ranked = [...this.providerStates.values()]
      .sort((left, right) => right.score - left.score)
      .map((state) => ({
        provider: state.name,
        score: Number(state.score.toFixed(2)),
        event_to_detection_ms: state.lastEventToDetectionMs,
        eth_getLogs_ms: state.lastGetLogsMs,
        flashblocks_lead_ms: state.lastFlashblockLeadMs,
        missed_opps: state.missedOpportunities,
      }));
    this.config.logger.info("multi_ws_provider_ranking", {
      chain: this.config.chain,
      rankedProviders: ranked,
    });
  }

  private stopAll(): void {
    if (this.promoteTimer !== undefined) {
      clearInterval(this.promoteTimer);
      this.promoteTimer = undefined;
    }
    for (const stop of this.stopFns.splice(0)) {
      stop();
    }
    for (const timer of this.reconnectTimers.splice(0)) {
      clearTimeout(timer);
    }
    this.reconnectAttemptByProvider.clear();
    this.heartbeatByProvider.clear();
    this.providerStopFns.clear();
    this.dedupe.clear();
    for (const client of this.wsClients.splice(0)) {
      try {
        const typed = client as {
          close?: () => void;
          transport?: { close?: () => void; value?: { close?: () => void; destroy?: () => void } };
        };
        typed.close?.();
        typed.transport?.close?.();
        typed.transport?.value?.close?.();
        typed.transport?.value?.destroy?.();
      } catch {
        // best-effort teardown to avoid leaked websocket handles in tests/runs
      }
    }
  }

  private pickAlternateEndpoint(
    failedName: string,
    failedUrl: string,
  ): { readonly name: string; readonly wsUrl: string } {
    const candidates = this.endpointUrls.filter((entry) => entry.wsUrl !== failedUrl);
    if (candidates.length === 0) {
      return { name: failedName, wsUrl: failedUrl };
    }
    const failedHost = hostFromUrl(failedUrl);
    const crossVendor = candidates.find((entry) => hostFromUrl(entry.wsUrl) !== failedHost);
    return crossVendor ?? candidates[0]!;
  }

  private stopProviderSubscriptions(_providerName: string): void {
    const providerStops = this.providerStopFns.get(_providerName) ?? [];
    for (const stop of providerStops) {
      stop();
    }
    this.providerStopFns.delete(_providerName);
    this.stopFns.splice(0, this.stopFns.length, ...this.stopFns.filter((fn) => !providerStops.includes(fn)));
  }

  private seedProvider(providerName: string): void {
    this.ftrl.observe({
      chain: this.config.chain,
      opportunityId: `${providerName}:seed`,
      features: [`provider:${providerName}`, "signal:seed"],
      expectedProfitBps: 100,
      outcome: providerName === "primary" ? "won" : "missed",
    });
  }

  private ftrlBoost(providerName: string): number {
    const ranked = this.ftrl.rank([
      {
        chain: this.config.chain,
        opportunityId: "primary",
        features: ["provider:primary"],
        expectedProfitBps: 100,
      },
      {
        chain: this.config.chain,
        opportunityId: "secondary",
        features: ["provider:secondary"],
        expectedProfitBps: 100,
      },
      {
        chain: this.config.chain,
        opportunityId: "tertiary",
        features: ["provider:tertiary"],
        expectedProfitBps: 100,
      },
    ]);
    const top = ranked[0]?.opportunityId;
    return top === providerName ? 0.3 : 0;
  }
}

function hostFromUrl(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

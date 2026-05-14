import type { Address } from "viem";
import { createFailoverPublicClient, createChainWebSocketPublicClient, type SupportedChain } from "../config/chains";
import type { ChainRegistry } from "../config/chainRegistry";
import { aavePoolAbi } from "../protocols/aaveV3";
import type { BotMetrics, LoggerLike } from "../bot";
import type { DetectionEventHandlers, DetectionEventSource } from "./hybridDetectionPipeline";
import { BayesianHazardModel, FtrlOpportunityRanker } from "../optimization/hazardPrediction";

const trackedEvents = ["ReserveDataUpdated", "Borrow", "Supply", "Repay", "Withdraw"] as const;
type TrackedEventName = (typeof trackedEvents)[number];

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
}

export class MultiWsEventSource implements DetectionEventSource {
  private readonly dedupe = new Set<string>();
  private readonly providerStates = new Map<string, ProviderState>();
  private readonly stopFns: Array<() => void> = [];
  private readonly reconnectTimers: NodeJS.Timeout[] = [];
  private readonly wsClients: unknown[] = [];
  private readonly readClient;
  private readonly model = new BayesianHazardModel();
  private readonly ftrl = new FtrlOpportunityRanker({ model: this.model });

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
    if (endpoints.length === 0) {
      throw new Error("MultiWsEventSource requires at least one detection websocket endpoint");
    }
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
      this.subscribeProvider(endpoint.name, endpoint.wsUrl, handlers);
    }
    return () => this.stopAll();
  }

  private wsEndpoints(): Array<{ readonly name: string; readonly wsUrl: string }> {
    const detection = this.config.registry.get(this.config.chain).detection;
    return [
      detection.wsPrimary === undefined ? undefined : { name: "primary", wsUrl: detection.wsPrimary },
      detection.wsSecondary === undefined ? undefined : { name: "secondary", wsUrl: detection.wsSecondary },
      detection.wsTertiary === undefined ? undefined : { name: "tertiary", wsUrl: detection.wsTertiary },
    ].filter((entry): entry is { readonly name: string; readonly wsUrl: string } => entry !== undefined);
  }

  private subscribeProvider(providerName: string, wsUrl: string, handlers: DetectionEventHandlers): void {
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
      }
    }
    if (this.config.registry.get(this.config.chain).detection.flashblocksEnabled) {
      const stopFlash = wsClient.watchBlockNumber?.({
        onBlockNumber: async (blockNumber) => {
          const started = Date.now();
          const logs = await this.readClient.getLogs({
            address: poolAddress,
            fromBlock: blockNumber,
            toBlock: blockNumber,
          });
          const state = this.providerStates.get(providerName);
          if (state !== undefined) {
            state.lastFlashblockLeadMs = Math.max(1, Date.now() - started);
            state.score += state.lastFlashblockLeadMs <= 120 ? 1 : -0.5;
            this.config.metrics.recordPipelineLatency("flashblocks_lead_ms", state.lastFlashblockLeadMs, {
              chain: this.config.chain,
              provider: providerName,
              flashblocks,
            });
          }
          await this.handleLogs(providerName, "ReserveDataUpdated", logs, handlers);
        },
        onError: (error) => handlers.onError(this.config.chain, error),
      });
      if (stopFlash !== undefined) {
        this.stopFns.push(stopFlash);
      }
    }
  }

  private scheduleReconnect(providerName: string, wsUrl: string, handlers: DetectionEventHandlers): void {
    const jitter = Math.floor(Math.random() * 150);
    const timer = setTimeout(() => {
      this.subscribeProvider(providerName, wsUrl, handlers);
    }, 500 + jitter);
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
      if (reserve === undefined) {
        continue;
      }
      const dedupeKey = `${shaped.blockHash ?? "na"}:${shaped.transactionHash ?? "na"}:${String(shaped.logIndex ?? "na")}`;
      if (this.dedupe.has(dedupeKey)) {
        continue;
      }
      this.dedupe.add(dedupeKey);
      if (this.dedupe.size > 50_000) {
        const first = this.dedupe.values().next().value;
        if (first !== undefined) {
          this.dedupe.delete(first);
        }
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
    for (const stop of this.stopFns.splice(0)) {
      stop();
    }
    for (const timer of this.reconnectTimers.splice(0)) {
      clearTimeout(timer);
    }
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

import type { Address } from "viem";
import { createFailoverPublicClient, createChainWebSocketPublicClient, type SupportedChain } from "../config/chains";
import type { ChainRegistry } from "../config/chainRegistry";
import { aavePoolAbi } from "../protocols/aaveV3";
import type { BotMetrics, LoggerLike } from "../bot";
import type { DetectionEventHandlers, DetectionEventSource } from "./hybridDetectionPipeline";
import { BayesianHazardModel } from "../optimization/hazardPrediction";
import { FTRLProviderScorer } from "./FTRLProviderScorer";

const trackedEvents = ["ReserveDataUpdated", "Borrow", "Supply", "Repay", "Withdraw"] as const;
type TrackedEventName = (typeof trackedEvents)[number];

interface ProviderState {
  readonly name: string;
  readonly wsUrl: string;
  legacyScore: number;
  eventCount: number;
  missedOpportunities: number;
  lastEventToDetectionMs: number;
  lastGetLogsMs: number;
  lastFlashblockLeadMs: number;
}

export interface MultiWsFtrlScoringConfig {
  readonly enabled?: boolean;
  readonly rolloutPct?: number;
  readonly randomSeed?: number;
  readonly persistencePath?: string;
}

export interface MultiWsEventSourceConfig {
  readonly registry: ChainRegistry;
  readonly chain: SupportedChain;
  readonly logger: LoggerLike;
  readonly metrics: BotMetrics;
  readonly ftrlScoring?: MultiWsFtrlScoringConfig;
}

export class MultiWsEventSource implements DetectionEventSource {
  private readonly dedupe = new Set<string>();
  private readonly providerStates = new Map<string, ProviderState>();
  private readonly stopFns: Array<() => void> = [];
  private readonly reconnectTimers: NodeJS.Timeout[] = [];
  private readonly wsClients: unknown[] = [];
  private readonly readClient;
  private readonly hazardModel = new BayesianHazardModel();
  private scorer?: FTRLProviderScorer;

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
        legacyScore: 0,
        eventCount: 0,
        missedOpportunities: 0,
        lastEventToDetectionMs: 0,
        lastGetLogsMs: 0,
        lastFlashblockLeadMs: 0,
      });
    }
    this.scorer = new FTRLProviderScorer({
      providerIds: endpoints.map((endpoint) => endpoint.name),
      enabled: this.config.ftrlScoring?.enabled ?? false,
      rolloutPct: this.config.ftrlScoring?.rolloutPct ?? 10,
      randomSeed: this.config.ftrlScoring?.randomSeed ?? 1_337,
      ...(this.config.ftrlScoring?.persistencePath === undefined ? {} : { persistencePath: this.config.ftrlScoring.persistencePath }),
    });
    for (const endpoint of endpoints) {
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
            state.legacyScore -= 2;
            const hazard = this.hazardForProvider(providerName);
            this.scorer?.updateFromError(providerName, {
              missedOpportunities: state.missedOpportunities,
              estimatedMissedEvUsd: this.estimatedMissedEvUsd(),
              errorRate: 1,
              errorSeverity: "outage",
              hazardBps: hazard,
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
            state.legacyScore += state.lastFlashblockLeadMs <= 120 ? 1 : -0.5;
            this.scorer?.updateFromLatency(providerName, {
              flashblocksLeadMs: state.lastFlashblockLeadMs,
              hazardBps: this.hazardForProvider(providerName),
            });
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
      provider.legacyScore += 1;
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
          provider.legacyScore += provider.lastGetLogsMs <= 100 ? 0.5 : -0.5;
        } catch {
          provider.legacyScore -= 1;
          this.scorer?.updateFromError(providerName, {
            errorRate: 0.5,
            errorSeverity: "transient",
            hazardBps: this.hazardForProvider(providerName),
          });
        }
      }
      const hazardBps = this.hazardForProvider(providerName);
      const loss = this.scorer?.updateFromEvent(providerName, {
        eventToDetectionMs: provider.lastEventToDetectionMs,
        getLogsLatencyMs: provider.lastGetLogsMs,
        flashblocksLeadMs: provider.lastFlashblockLeadMs,
        missedOpportunities: provider.missedOpportunities,
        estimatedMissedEvUsd: this.estimatedMissedEvUsd(),
        errorRate: provider.missedOpportunities > 0
          ? provider.missedOpportunities / Math.max(1, provider.eventCount + provider.missedOpportunities)
          : 0,
        errorSeverity: provider.missedOpportunities > 2 ? "repeated" : "transient",
        hazardBps,
      });
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
        legacy_score: provider.legacyScore,
      });
      if (loss !== undefined) {
        this.config.metrics.recordProviderLossComponent("latency", loss.latency, {
          chain: this.config.chain,
          provider: providerName,
        });
        this.config.metrics.recordProviderLossComponent("missed_ev", loss.missedEv, {
          chain: this.config.chain,
          provider: providerName,
        });
        this.config.metrics.recordProviderLossComponent("get_logs", loss.getLogs, {
          chain: this.config.chain,
          provider: providerName,
        });
        this.config.metrics.recordProviderLossComponent("flashblocks", loss.flashblocks, {
          chain: this.config.chain,
          provider: providerName,
        });
        this.config.metrics.recordProviderLossComponent("error", loss.error, {
          chain: this.config.chain,
          provider: providerName,
        });
        this.config.metrics.recordProviderLossComponent("hazard", loss.hazard, {
          chain: this.config.chain,
          provider: providerName,
        });
      }
    }

    const diagnostics = this.scorer?.getDiagnostics();
    const selectedProvider = this.scorer?.samplePrimary();
    const useFtrl = this.scorer?.shouldUseFtrl() ?? false;
    const ranked = [...this.providerStates.values()]
      .sort((left, right) => {
        if (!useFtrl || diagnostics === undefined) {
          return right.legacyScore - left.legacyScore;
        }
        return (diagnostics.probabilities[right.name] ?? 0) - (diagnostics.probabilities[left.name] ?? 0);
      })
      .map((state) => {
        const probability = diagnostics?.probabilities[state.name] ?? 0;
        this.config.metrics.recordProviderWeight(probability, {
          chain: this.config.chain,
          provider: state.name,
        });
        return {
          provider: state.name,
          legacy_score: Number(state.legacyScore.toFixed(3)),
          probability: Number(probability.toFixed(6)),
          cumulative_loss: Number((diagnostics?.cumulativeLosses[state.name] ?? 0).toFixed(6)),
          event_to_detection_ms: state.lastEventToDetectionMs,
          eth_getLogs_ms: state.lastGetLogsMs,
          flashblocks_lead_ms: state.lastFlashblockLeadMs,
          missed_opps: state.missedOpportunities,
        };
      });
    if (diagnostics !== undefined) {
      this.config.metrics.recordProviderRegret("best_fixed", "instantaneous", diagnostics.instantaneousRegretBestFixed, {
        chain: this.config.chain,
      });
      this.config.metrics.recordProviderRegret("best_fixed", "cumulative", diagnostics.cumulativeRegretBestFixed, {
        chain: this.config.chain,
      });
      this.config.metrics.recordProviderRegret(
        "best_hindsight_signal",
        "cumulative",
        diagnostics.cumulativeRegretBestHindsightSignal,
        { chain: this.config.chain },
      );
    }
    if (selectedProvider !== undefined) {
      this.config.metrics.recordProviderSelection({
        chain: this.config.chain,
        provider: selectedProvider,
        mode: useFtrl ? "ftrl" : "legacy",
      });
    }
    this.config.logger.info("multi_ws_provider_ranking", {
      chain: this.config.chain,
      mode: useFtrl ? "ftrl" : "legacy",
      selectedProvider,
      eta: diagnostics?.eta,
      epsilon: diagnostics?.epsilon,
      fallbackActive: diagnostics?.fallbackActive,
      cumulativeRegretBestFixed: diagnostics?.cumulativeRegretBestFixed,
      cumulativeRegretBestHindsightSignal: diagnostics?.cumulativeRegretBestHindsightSignal,
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
    this.scorer?.updateFromEvent(providerName, {
      eventToDetectionMs: providerName === "primary" ? 15 : 50,
      getLogsLatencyMs: 20,
      flashblocksLeadMs: 80,
      hazardBps: this.hazardForProvider(providerName),
      estimatedMissedEvUsd: this.estimatedMissedEvUsd(),
    });
  }

  private estimatedMissedEvUsd(): number {
    const minProfitUsd = Number(process.env.MIN_PROFIT_USD ?? "10");
    return Number.isFinite(minProfitUsd) && minProfitUsd > 0 ? minProfitUsd : 10;
  }

  private hazardForProvider(providerName: string): number {
    const prediction = this.hazardModel.predict({
      chain: this.config.chain,
      opportunityId: `${providerName}:hazard`,
      features: [`provider:${providerName}`],
      expectedProfitBps: 100,
    });
    return prediction.hazardBps;
  }
}

import type { Address } from "viem";
import type { BotMetrics, LoggerLike } from "../bot";
import type { ChainRegistry, CircuitBreakerName, CircuitBreakerState } from "../config/chainRegistry";
import type { SupportedChain } from "../config/chains";
import {
  ReserveAwareBorrowerCache,
  type BorrowerSnapshot,
} from "./reserveAwareBorrowerCache";
import type { LiquidationCandidateGate } from "../orchestrator/liquidationCandidateGate";

export interface DetectionReserveEvent {
  readonly chain: SupportedChain;
  readonly reserve: Address;
}

export interface DetectionEventHandlers {
  readonly onReserveUpdated: (event: DetectionReserveEvent) => void;
  readonly onError: (chain: SupportedChain, error: Error) => void;
}

export interface DetectionEventSource {
  start(handlers: DetectionEventHandlers): (() => void) | Promise<() => void>;
}

export interface BorrowerSnapshotProvider {
  getBorrowersForReserve(chain: SupportedChain, reserve: Address): Promise<Address[]>;
  refreshBorrowers(chain: SupportedChain, accounts: readonly Address[]): Promise<readonly BorrowerSnapshot[]>;
  refreshWatchlistBorrowers?(
    chain: SupportedChain,
    accounts: readonly Address[],
  ): Promise<readonly BorrowerSnapshot[]>;
  pollBorrowers(chain: SupportedChain): Promise<readonly BorrowerSnapshot[]>;
}

export interface HybridDetectionPipelineConfig {
  readonly registry: ChainRegistry;
  readonly eventSource: DetectionEventSource;
  readonly provider: BorrowerSnapshotProvider;
  readonly logger: LoggerLike;
  readonly metrics: BotMetrics;
  readonly failureThreshold?: number;
  readonly liquidationGate?: LiquidationCandidateGate;
  readonly onDetectionFailure?: () => void;
}

export class HybridDetectionPipeline {
  public readonly cache = new ReserveAwareBorrowerCache();
  private readonly circuitBreakers = new Map<string, CircuitBreakerState>();
  private readonly pendingWork = new Set<Promise<void>>();
  private stopEvents: (() => void) | undefined;
  private readonly failureThreshold: number;

  public constructor(private readonly config: HybridDetectionPipelineConfig) {
    this.failureThreshold = config.failureThreshold ?? 3;
    for (const chain of config.registry.listChains()) {
      for (const name of ["rpc", "subgraph", "execution"] satisfies CircuitBreakerName[]) {
        this.circuitBreakers.set(circuitKey(chain, name), config.registry.get(chain).circuitBreakers[name]);
      }
    }
  }

  public async start(): Promise<void> {
    if (this.stopEvents !== undefined) {
      return;
    }

    this.stopEvents = await this.config.eventSource.start({
      onReserveUpdated: (event) => this.enqueue(() => this.handleReserveUpdated(event)),
      onError: (chain, error) => this.handleEventSourceError(chain, error),
    });
  }

  public stop(): void {
    this.stopEvents?.();
    this.stopEvents = undefined;
  }

  public async drain(): Promise<void> {
    while (this.pendingWork.size > 0) {
      await Promise.all([...this.pendingWork]);
    }
  }

  public async pollFallback(chain: SupportedChain): Promise<void> {
    const startedAt = Date.now();
    const resolvedAave = this.config.registry.getResolvedAave(chain);
    try {
      const snapshots = await this.config.provider.pollBorrowers(chain);
      this.upsertSnapshots(snapshots);
      this.config.logger.info("fallback_poll_complete", {
        chain,
        borrowers: snapshots.length,
        pool: resolvedAave.pool,
        poolAddressesProvider: resolvedAave.poolAddressesProvider,
      });
    } catch (error) {
      this.recordFailure(chain, "subgraph", error);
    } finally {
      this.config.metrics.recordLatency("scan", (Date.now() - startedAt) / 1_000, { chain });
    }
  }

  public getCircuitBreakerState(chain: SupportedChain, name: CircuitBreakerName): CircuitBreakerState {
    const state = this.circuitBreakers.get(circuitKey(chain, name));
    if (state === undefined) {
      throw new Error(`Circuit breaker is not registered: ${chain}:${name}`);
    }

    return state;
  }

  private enqueue(work: () => Promise<void>): void {
    const task = work().finally(() => this.pendingWork.delete(task));
    this.pendingWork.add(task);
  }

  private async handleReserveUpdated(event: DetectionReserveEvent): Promise<void> {
    const startedAt = Date.now();
    const resolvedAave = this.config.registry.getResolvedAave(event.chain);
    try {
      const borrowers = this.getCachedBorrowersForReserve(event.chain, event.reserve);
      const targetBorrowers = borrowers.length > 0
        ? borrowers
        : await this.config.provider.getBorrowersForReserve(event.chain, event.reserve);
      if (targetBorrowers.length === 0) {
        this.config.logger.info("reserve_event_refresh_skipped_no_borrowers", {
          chain: event.chain,
          reserve: event.reserve,
        });
        return;
      }
      const snapshots = await this.config.provider.refreshBorrowers(event.chain, targetBorrowers);
      this.upsertSnapshots(snapshots);
      if (this.config.liquidationGate !== undefined && snapshots.length > 0) {
        await this.config.liquidationGate.auditBorrowerSnapshots(event.chain, snapshots);
      }
      this.config.logger.info("reserve_event_refresh_complete", {
        chain: event.chain,
        reserve: event.reserve,
        borrowers: targetBorrowers.length,
        pool: resolvedAave.pool,
        poolAddressesProvider: resolvedAave.poolAddressesProvider,
      });
    } catch (error) {
      this.recordFailure(event.chain, "rpc", error);
    } finally {
      this.config.metrics.recordLatency("scan", (Date.now() - startedAt) / 1_000, { chain: event.chain });
    }
  }

  private handleEventSourceError(chain: SupportedChain, error: Error): void {
    this.recordFailure(chain, "rpc", error);
  }

  private recordFailure(chain: SupportedChain, breaker: CircuitBreakerName, error: unknown): void {
    const current = this.getCircuitBreakerState(chain, breaker);
    const failures = current.failures + 1;
    const nextState: CircuitBreakerState = failures >= this.failureThreshold
      ? { status: "open", failures, openedAtMs: Date.now() }
      : { status: current.status, failures };
    this.circuitBreakers.set(circuitKey(chain, breaker), nextState);
    this.config.metrics.recordError();
    this.config.logger.error("hybrid_detection_failure", { chain, breaker, error });
    this.config.onDetectionFailure?.();
  }

  private upsertSnapshots(snapshots: readonly BorrowerSnapshot[]): void {
    for (const snapshot of snapshots) {
      this.cache.upsert(snapshot);
    }
  }

  private getCachedBorrowersForReserve(chain: SupportedChain, reserve: Address): Address[] {
    const lowerReserve = reserve.toLowerCase();
    const unique = new Set<Address>();
    for (const snapshot of this.cache.listSnapshots(chain)) {
      const touchesReserve = snapshot.reserves.some(
        (entry) => entry.assetAddress.toLowerCase() === lowerReserve,
      );
      if (touchesReserve) {
        unique.add(snapshot.account);
      }
    }
    return [...unique];
  }
}

function circuitKey(chain: SupportedChain, name: CircuitBreakerName): string {
  return `${chain}:${name}`;
}

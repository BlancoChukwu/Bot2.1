import type { Address } from "viem";
import type { BotMetrics, LoggerLike } from "../bot";
import type { ChainRegistry } from "../config/chainRegistry";
import type { SupportedChain } from "../config/chains";
import { HybridDetectionPipeline, type BorrowerSnapshotProvider, type DetectionEventHandlers } from "../monitors/hybridDetectionPipeline";
import type { BorrowerSnapshot } from "../monitors/reserveAwareBorrowerCache";

export interface ReplayEvent {
  readonly atMs: number;
  readonly chain: SupportedChain;
  readonly reserve: Address;
}

export interface ReplayHarnessConfig {
  readonly registry: ChainRegistry;
  readonly provider: BorrowerSnapshotProvider;
  readonly logger: LoggerLike;
  readonly metrics: BotMetrics;
  readonly events: readonly ReplayEvent[];
}

export class ReplayHarness {
  public constructor(private readonly config: ReplayHarnessConfig) {}

  public async run(): Promise<readonly BorrowerSnapshot[]> {
    let handlers: DetectionEventHandlers | undefined;
    const pipeline = new HybridDetectionPipeline({
      registry: this.config.registry,
      provider: this.config.provider,
      logger: this.config.logger,
      metrics: this.config.metrics,
      eventSource: {
        start: (nextHandlers) => {
          handlers = nextHandlers;
          return () => undefined;
        },
      },
    });
    await pipeline.start();
    for (const event of [...this.config.events].sort((left, right) => left.atMs - right.atMs)) {
      handlers?.onReserveUpdated({ chain: event.chain, reserve: event.reserve });
    }
    await pipeline.drain();
    pipeline.stop();

    return this.config.registry.listChains().flatMap((chain) => pipeline.cache.listSnapshots(chain));
  }
}

import type { ChainRegistry } from "../config/chainRegistry";
import type { SupportedChain } from "../config/chains";
import type { LoggerLike } from "../bot";

const defaultThreshold = 3;
const defaultOpenMs = 60_000;

export class SimFailureCircuitBreaker {
  private consecutive = 0;
  private reopenTimer: NodeJS.Timeout | undefined;

  public constructor(
    private readonly config: {
      readonly registry: ChainRegistry;
      readonly chain: SupportedChain;
      readonly logger: LoggerLike;
      readonly threshold?: number;
      readonly openMs?: number;
      readonly onOpen?: () => void;
    },
  ) {}

  public recordSimFailure(reason: string): void {
    if (reason !== "final_simulation_failed") {
      return;
    }
    this.consecutive += 1;
    const threshold = this.config.threshold ?? defaultThreshold;
    if (this.consecutive < threshold) {
      return;
    }
    this.openCircuit();
  }

  public recordSuccess(): void {
    this.consecutive = 0;
  }

  private openCircuit(): void {
    const chain = this.config.registry.get(this.config.chain);
    this.config.registry.setCircuitBreakerState(this.config.chain, "execution", {
      status: "open",
      failures: chain.circuitBreakers.execution.failures + 1,
      openedAtMs: Date.now(),
    });
    this.config.logger.error("execution_circuit_open", {
      chain: this.config.chain,
      consecutiveSimFailures: this.consecutive,
      openMs: this.config.openMs ?? defaultOpenMs,
    });
    this.config.onOpen?.();
    if (this.reopenTimer !== undefined) {
      clearTimeout(this.reopenTimer);
    }
    const openMs = this.config.openMs ?? defaultOpenMs;
    this.reopenTimer = setTimeout(() => {
      this.config.registry.setCircuitBreakerState(this.config.chain, "execution", {
        status: "closed",
        failures: 0,
      });
      this.consecutive = 0;
      this.config.logger.info("execution_circuit_closed", { chain: this.config.chain });
    }, openMs);
    this.reopenTimer.unref?.();
  }
}

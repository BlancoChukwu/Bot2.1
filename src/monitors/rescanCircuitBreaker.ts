import type { LoggerLike } from "../bot";

export interface RescanCircuitBreakerConfig {
  readonly threshold?: number;
  readonly cooldownMs?: number;
  readonly logger?: LoggerLike;
  readonly onOpen?: () => void;
  readonly onClose?: () => void;
}

/**
 * Sheds block-triggered subgraph rescans after repeated failures (Graph quota, skip limits, etc.).
 */
export class RescanCircuitBreaker {
  private failures = 0;
  private coolingDown = false;
  private cooldownTimer: NodeJS.Timeout | undefined;

  public constructor(private readonly config: RescanCircuitBreakerConfig = {}) {}

  public isCoolingDown(): boolean {
    return this.coolingDown;
  }

  public async execute(fn: () => Promise<void>, onFailure?: (error: unknown) => void): Promise<void> {
    if (this.coolingDown) {
      return;
    }
    try {
      await fn();
      this.failures = 0;
    } catch (error) {
      this.failures += 1;
      if (this.failures <= (this.config.threshold ?? 3)) {
        onFailure?.(error);
      }
      if (this.failures >= (this.config.threshold ?? 3)) {
        this.openCircuit();
      }
    }
  }

  public stop(): void {
    if (this.cooldownTimer !== undefined) {
      clearTimeout(this.cooldownTimer);
      this.cooldownTimer = undefined;
    }
    this.coolingDown = false;
    this.failures = 0;
  }

  private openCircuit(): void {
    if (this.coolingDown) {
      return;
    }
    this.coolingDown = true;
    this.config.logger?.warn("watchlist_circuit_breaker_open", {
      failures: this.failures,
      cooldownMs: this.config.cooldownMs ?? 30_000,
    });
    this.config.onOpen?.();
    const cooldownMs = this.config.cooldownMs ?? 30_000;
    this.cooldownTimer = setTimeout(() => {
      this.coolingDown = false;
      this.failures = 0;
      this.cooldownTimer = undefined;
      this.config.logger?.info("watchlist_circuit_breaker_closed", { cooldownMs });
      this.config.onClose?.();
    }, cooldownMs);
    this.cooldownTimer.unref?.();
  }
}

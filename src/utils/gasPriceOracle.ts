export interface GasPriceOracleClient {
  getGasPrice(): Promise<bigint>;
}

export interface GasPriceOracleConfig {
  readonly client: GasPriceOracleClient;
  readonly ttlMs?: number;
  readonly nowMs?: () => number;
}

const defaultTtlMs = 30_000;

export class GasPriceOracle {
  private readonly ttlMs: number;
  private readonly nowMs: () => number;
  private cached: { readonly gasPrice: bigint; readonly updatedAtMs: number } | undefined;
  private inFlight: Promise<bigint> | undefined;

  public constructor(private readonly config: GasPriceOracleConfig) {
    this.ttlMs = config.ttlMs ?? defaultTtlMs;
    this.nowMs = config.nowMs ?? (() => Date.now());
  }

  public async getGasPrice(): Promise<bigint> {
    const current = this.cached;
    if (current !== undefined && this.nowMs() - current.updatedAtMs < this.ttlMs) {
      return current.gasPrice;
    }
    if (this.inFlight !== undefined) {
      return this.inFlight;
    }

    this.inFlight = this.config.client.getGasPrice()
      .then((gasPrice) => {
        this.cached = { gasPrice, updatedAtMs: this.nowMs() };
        return gasPrice;
      })
      .finally(() => {
        this.inFlight = undefined;
      });
    return this.inFlight;
  }
}

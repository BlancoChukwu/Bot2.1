import type { Address } from "viem";

export interface PoolMirrorState {
  readonly pool: Address;
  readonly sqrtPriceX96: bigint;
  readonly liquidity: bigint;
  readonly tick: number;
  readonly updatedAtMs: number;
}

/**
 * In-memory AMM mirror fed by Flashblock pool logs (Swap/Sync/Mint/Burn).
 * Used when USE_LOCAL_MIRROR=true to avoid HTTP quoter calls on warm paths.
 */
export class AmmMirror {
  private readonly pools = new Map<string, PoolMirrorState>();
  private eventsReceived = 0;
  private lastSwapTimestamp: number | undefined;

  public upsert(state: PoolMirrorState): void {
    this.pools.set(state.pool.toLowerCase(), state);
    this.eventsReceived += 1;
    this.lastSwapTimestamp = state.updatedAtMs;
  }

  public recordSwapEvent(updatedAtMs = Date.now()): void {
    this.eventsReceived += 1;
    this.lastSwapTimestamp = updatedAtMs;
  }

  public getEventsReceived(): number {
    return this.eventsReceived;
  }

  public getLastSwapTimestamp(): number | undefined {
    return this.lastSwapTimestamp;
  }

  public get(pool: Address): PoolMirrorState | undefined {
    return this.pools.get(pool.toLowerCase());
  }

  public size(): number {
    return this.pools.size;
  }

  public isWarm(): boolean {
    return this.pools.size > 0;
  }

  public quoteExactInputSingle(
    pool: Address,
    amountIn: bigint,
    zeroForOne: boolean,
  ): bigint | undefined {
    const state = this.get(pool);
    if (state === undefined || amountIn <= 0n) {
      return undefined;
    }
    const q96 = 2n ** 96n;
    const price = state.sqrtPriceX96;
    if (price === 0n) {
      return undefined;
    }
    const ratio = (price * price) / q96;
    const out = zeroForOne
      ? (amountIn * ratio) / q96
      : (amountIn * q96) / (ratio === 0n ? 1n : ratio);
    return out > 0n ? out : undefined;
  }
}

let globalMirror: AmmMirror | undefined;

export function getAmmMirror(): AmmMirror {
  if (globalMirror === undefined) {
    globalMirror = new AmmMirror();
  }
  return globalMirror;
}

export function resetAmmMirror(): void {
  globalMirror = undefined;
}

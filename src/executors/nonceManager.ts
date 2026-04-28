import type { Address } from "viem";
import type { SupportedChain } from "../config/chains";

export interface NonceReservation {
  readonly chain: SupportedChain;
  readonly account: Address;
  readonly nonce: number;
}

interface NonceState {
  readonly initialized: Promise<void>;
  nextNonce: number | undefined;
  readonly released: number[];
  readonly active: Set<number>;
}

export class LocalNonceManager {
  private readonly states = new Map<string, NonceState>();

  public async reserve(
    chain: SupportedChain,
    account: Address,
    getPendingNonce: () => Promise<number>,
  ): Promise<NonceReservation> {
    const key = nonceKey(chain, account);
    const state = this.states.get(key) ?? this.createState(key, getPendingNonce);
    await state.initialized;

    const released = state.released.shift();
    if (released !== undefined) {
      state.active.add(released);
      return { chain, account, nonce: released };
    }

    const nonce = state.nextNonce;
    if (nonce === undefined) {
      throw new Error(`Nonce state was not initialized for ${key}`);
    }
    state.nextNonce = nonce + 1;
    state.active.add(nonce);

    return { chain, account, nonce };
  }

  public release(reservation: NonceReservation): void {
    const state = this.states.get(nonceKey(reservation.chain, reservation.account));
    if (state === undefined) {
      return;
    }
    if (!state.active.delete(reservation.nonce)) {
      return;
    }

    state.released.push(reservation.nonce);
    state.released.sort((left, right) => left - right);
  }

  public resync(chain: SupportedChain, account: Address, nextNonce: number): void {
    this.states.set(nonceKey(chain, account), {
      initialized: Promise.resolve(),
      nextNonce,
      released: [],
      active: new Set<number>(),
    });
  }

  private createState(key: string, getPendingNonce: () => Promise<number>): NonceState {
    const state: NonceState = {
      initialized: Promise.resolve()
        .then(() => getPendingNonce())
        .then((nonce) => {
          state.nextNonce = nonce;
        })
        .catch((error) => {
          this.states.delete(key);
          throw error;
        }),
      nextNonce: undefined,
      released: [],
      active: new Set<number>(),
    };
    this.states.set(key, state);
    return state;
  }
}

function nonceKey(chain: SupportedChain, account: Address): string {
  return `${chain}:${account.toLowerCase()}`;
}

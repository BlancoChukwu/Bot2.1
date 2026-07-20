import type { Address } from "viem";
import type { LoggerLike } from "../bot";
import type { DexConfig } from "../monitors/arbitrageScanner";
import { getAmmMirror } from "./ammMirror";

const MIRROR_COLD_RPC_FALLBACK_BLOCKS = 300;

interface ReadOnlyClient {
  readContract(args: Record<string, unknown>): Promise<unknown>;
}

const QUOTER_V2_ABI = [
  {
    name: "quoteExactInputSingle",
    type: "function",
    stateMutability: "view",
    inputs: [{
      components: [
        { name: "tokenIn", type: "address" },
        { name: "tokenOut", type: "address" },
        { name: "amountIn", type: "uint256" },
        { name: "fee", type: "uint24" },
        { name: "sqrtPriceLimitX96", type: "uint160" },
      ],
      name: "params",
      type: "tuple",
    }],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

const ROUTER_ABI = [
  {
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "path", type: "address[]" },
    ],
    name: "getAmountsOut",
    outputs: [{ name: "amounts", type: "uint256[]" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

export interface QuoteEngineConfig {
  readonly logger: LoggerLike;
  readonly useLocalMirror: boolean;
  readonly logArbDebug?: boolean;
  readonly chainHead?: () => Promise<bigint>;
  readonly startBlock?: bigint;
}

export interface QuoteDiagnostics {
  readonly mirrorStateSize: number;
  readonly lastSwapTimestamp: number | undefined;
  readonly eventsReceived: number;
  readonly forceRpcFallback: boolean;
}

/**
 * Local-mirror-aware quoter used by the arbitrage scanner.
 * Never silently skips RPC when the mirror is cold (first ~300 blocks).
 */
export class QuoteEngine {
  private readonly explicitStartBlock: bigint | undefined;
  private resolvedStartBlock: bigint | undefined;

  public constructor(private readonly config: QuoteEngineConfig) {
    this.explicitStartBlock = config.startBlock;
  }

  public async quoteAmountOut(
    client: ReadOnlyClient,
    dex: DexConfig,
    tokenIn: Address,
    tokenOut: Address,
    amountIn: bigint,
  ): Promise<bigint> {
    return this.quoteExactInputSingle(client, dex, tokenIn, tokenOut, amountIn, dex.quoterPoolFee ?? 3_000);
  }

  /**
   * Uniswap V3 QuoterV2 `quoteExactInputSingle` (or mirror / getAmountsOut fallback).
   * Returns tokenOut wei for `amountIn` of tokenIn at the given fee tier.
   */
  public async quoteExactInputSingle(
    client: ReadOnlyClient,
    dex: DexConfig,
    tokenIn: Address,
    tokenOut: Address,
    amountIn: bigint,
    fee: number,
  ): Promise<bigint> {
    const mirror = getAmmMirror();
    const diagnostics = await this.buildDiagnostics(mirror.size(), mirror.getLastSwapTimestamp(), mirror.getEventsReceived());
    this.config.logger.info("quote_engine_entry", {
      dex: dex.name,
      mirrorStateSize: diagnostics.mirrorStateSize,
      lastSwapTimestamp: diagnostics.lastSwapTimestamp,
      eventsReceived: diagnostics.eventsReceived,
      forceRpcFallback: diagnostics.forceRpcFallback,
      tokenIn,
      tokenOut,
      amountIn: amountIn.toString(),
      fee,
    });

    if (this.config.useLocalMirror && !diagnostics.forceRpcFallback && mirror.isWarm()) {
      const mirrored = mirror.quoteExactInputSingle(dex.router, amountIn, true);
      if (mirrored !== undefined) {
        return mirrored;
      }
    }

    return this.quoteViaRpc(client, { ...dex, quoterPoolFee: fee }, tokenIn, tokenOut, amountIn);
  }

  /** Batch quote helper — returns empty only when every probe amount fails. */
  public async getQuotesForPool(
    client: ReadOnlyClient,
    dex: DexConfig,
    tokenIn: Address,
    tokenOut: Address,
    amountsIn: readonly bigint[],
  ): Promise<readonly bigint[]> {
    const mirror = getAmmMirror();
    const diagnostics = await this.buildDiagnostics(mirror.size(), mirror.getLastSwapTimestamp(), mirror.getEventsReceived());
    this.config.logger.info("quote_engine_pool_entry", {
      dex: dex.name,
      mirrorStateSize: diagnostics.mirrorStateSize,
      lastSwapTimestamp: diagnostics.lastSwapTimestamp,
      eventsReceived: diagnostics.eventsReceived,
      forceRpcFallback: diagnostics.forceRpcFallback,
      probeCount: amountsIn.length,
    });

    if (
      this.config.useLocalMirror
      && !diagnostics.forceRpcFallback
      && diagnostics.mirrorStateSize === 0
    ) {
      this.config.logger.info("quote_engine_mirror_cold_rpc_fallback", {
        dex: dex.name,
        mirrorStateSize: 0,
      });
    }

    const outs: bigint[] = [];
    for (const amountIn of amountsIn) {
      if (amountIn <= 0n) {
        continue;
      }
      try {
        outs.push(await this.quoteAmountOut(client, dex, tokenIn, tokenOut, amountIn));
      } catch {
        // skip failed probe size
      }
    }
    return outs;
  }

  private async buildDiagnostics(
    mirrorStateSize: number,
    lastSwapTimestamp: number | undefined,
    eventsReceived: number,
  ): Promise<QuoteDiagnostics> {
    const forceRpcFallback = await this.shouldForceRpcFallback(mirrorStateSize);
    return { mirrorStateSize, lastSwapTimestamp, eventsReceived, forceRpcFallback };
  }

  private async shouldForceRpcFallback(mirrorStateSize: number): Promise<boolean> {
    if (!this.config.useLocalMirror) {
      return true;
    }
    if (mirrorStateSize > 0) {
      return false;
    }
    const blocksSinceStart = await this.blocksSinceStart();
    if (blocksSinceStart < BigInt(MIRROR_COLD_RPC_FALLBACK_BLOCKS)) {
      return true;
    }
    return true;
  }

  private async blocksSinceStart(): Promise<bigint> {
    if (this.config.chainHead === undefined) {
      return BigInt(MIRROR_COLD_RPC_FALLBACK_BLOCKS);
    }
    const head = await this.config.chainHead();
    const start = this.explicitStartBlock ?? this.resolvedStartBlock ?? head;
    if (this.explicitStartBlock === undefined && this.resolvedStartBlock === undefined) {
      this.resolvedStartBlock = head;
    }
    return head > start ? head - start : 0n;
  }

  private async quoteViaRpc(
    client: ReadOnlyClient,
    dex: DexConfig,
    tokenIn: Address,
    tokenOut: Address,
    amountIn: bigint,
  ): Promise<bigint> {
    let amountOut: bigint;
    let quoteSource: "quoterV2" | "getAmountsOut";
    if (dex.quoterV2 !== undefined) {
      const quoted = await client.readContract({
        address: dex.quoterV2,
        abi: QUOTER_V2_ABI,
        functionName: "quoteExactInputSingle",
        args: [{
          tokenIn,
          tokenOut,
          amountIn,
          fee: dex.quoterPoolFee ?? 3_000,
          sqrtPriceLimitX96: 0n,
        }],
      }) as readonly [bigint, bigint, number, bigint];
      amountOut = quoted[0];
      quoteSource = "quoterV2";
    } else {
      const amounts = await client.readContract({
        address: dex.router,
        abi: ROUTER_ABI,
        functionName: "getAmountsOut",
        args: [amountIn, [tokenIn, tokenOut]],
      }) as readonly bigint[];
      const out = amounts[1];
      if (out === undefined) {
        throw new Error("Malformed getAmountsOut output");
      }
      amountOut = out;
      quoteSource = "getAmountsOut";
    }
    if (this.config.logArbDebug) {
      this.config.logger.info("arbitrage_quote_debug", {
        dex: dex.name,
        quoteSource,
        tokenIn,
        tokenOut,
        amountIn: amountIn.toString(),
        amountOut: amountOut.toString(),
        ...(quoteSource === "quoterV2" ? { quoterPoolFee: dex.quoterPoolFee ?? 3_000 } : {}),
      });
    }
    return amountOut;
  }
}

import { encodeFunctionData, parseUnits, type Address } from "viem";
import type { BotMetrics, LoggerLike } from "../bot";
import type { ChainRegistry, FlashLoanProviderId } from "../config/chainRegistry";
import type { SupportedChain } from "../config/chains";
import { aavePoolAbi } from "../protocols/aaveV3";
import { encodeArbitrageRoute } from "../protocols/arbitrageFlashLoanReceiver";
import type { Asset, AssetAmount } from "../utils/typedAssetMath";
import { createAssetAmount } from "../utils/typedAssetMath";
import {
  AAVE_V3_BASE_FLASH_FEE_BPS,
  calculateExactUsdEV,
  calculateFlashLoanArbitrageEV,
  MIN_PROFIT_THRESHOLD_BNB,
  MIN_PROFIT_THRESHOLD_WEI,
  simulateFullFlashLoanArbPath,
} from "../utils/evCalculator";
import type { PriceOracleCache } from "../utils/priceOracleCache";
import {
  ProfitabilityEngine,
  type ProfitSimulationInput,
  type ProfitabilityResult,
} from "../profitability/profitabilityEngine";

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

export interface DexConfig {
  readonly name: string;
  readonly router: Address;
  readonly feeBps: number;
  readonly quoterV2?: Address;
  readonly quoterPoolFee?: number;
}

export interface TokenPairConfig {
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  readonly symbolIn: string;
  readonly symbolOut: string;
  readonly decimalsIn: number;
  readonly decimalsOut: number;
}

export interface ArbitrageOpportunity {
  readonly chain: SupportedChain;
  readonly opportunityId: string;
  readonly buyDex: DexConfig;
  readonly sellDex: DexConfig;
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  readonly amountIn: bigint;
  readonly expectedIntermediateOut: bigint;
  readonly expectedAmountOut: bigint;
  readonly expectedRevenue: AssetAmount;
  readonly estimatedGas: AssetAmount;
  readonly flashLoanFee: AssetAmount;
  readonly slippageBuffer: AssetAmount;
  readonly safetyBuffer: AssetAmount;
  readonly capitalAtRisk: AssetAmount;
  readonly provider: FlashLoanProviderId;
  readonly minimumMarginBps: number;
}

export interface ArbitrageOpportunitySink {
  push(opportunity: ArbitrageOpportunity): void;
}

interface ReadOnlyClient {
  readContract(args: Record<string, unknown>): Promise<unknown>;
  getGasPrice(): Promise<bigint>;
  call(args: Record<string, unknown>): Promise<unknown>;
  estimateGas?(args: Record<string, unknown>): Promise<bigint>;
}

interface DebugCapableLogger extends LoggerLike {
  debug?(message: string, meta?: unknown): void;
}

export interface ArbitrageScannerConfig {
  readonly registry: ChainRegistry;
  readonly profitabilityEngine: ProfitabilityEngine;
  readonly logger: LoggerLike;
  readonly metrics: BotMetrics;
  readonly publicClientFactory: (chain: SupportedChain) => ReadOnlyClient;
  readonly getDexesForChain: (chain: SupportedChain) => readonly DexConfig[];
  readonly getMonitoredPairsForChain: (chain: SupportedChain) => readonly TokenPairConfig[];
  readonly pollIntervalMs?: number;
  readonly minProfitMarginBps?: number;
  readonly stablePairProbeSize?: bigint;
  readonly volatilePairProbeSize?: bigint;
  readonly dedupeWindowMs?: number;
  readonly defaultFlashLoanProvider: FlashLoanProviderId;
  readonly opportunitySink?: ArbitrageOpportunitySink;
  readonly flashLoanReceiverAddress?: Address;
  readonly operatorAddress?: Address;
  readonly baseStableProbeSizes?: readonly bigint[];
  readonly baseStableExpandedProbeSize?: bigint;
  readonly flashLoanGasEstimate?: bigint;
  readonly flashFeeBps?: number;
  readonly baseMinProfitThreshold?: bigint;
  readonly arbitrageSlippageBps?: number;
  readonly exactUsdPriceCache?: Pick<PriceOracleCache, "batchGetUsdPrices">;
  readonly nativeGasTokenByChain?: Readonly<Record<SupportedChain, Address>>;
  readonly nativeGasTokenDecimalsByChain?: Readonly<Record<SupportedChain, number>>;
  readonly exactUsdMinProfitRaw?: bigint;
  readonly quoteConcurrency?: number;
}

export class ArbitrageScanner {
  private readonly config: ArbitrageScannerConfig & {
    readonly pollIntervalMs: number;
    readonly minProfitMarginBps: number;
    readonly stablePairProbeSize: bigint;
    readonly volatilePairProbeSize: bigint;
    readonly dedupeWindowMs: number;
    readonly baseStableProbeSizes: readonly bigint[];
    readonly baseStableExpandedProbeSize: bigint;
    readonly flashLoanGasEstimate: bigint;
    readonly flashFeeBps: number;
    readonly baseMinProfitThreshold: bigint;
    readonly arbitrageSlippageBps: number;
    readonly nativeGasTokenByChain: Readonly<Record<SupportedChain, Address>>;
    readonly nativeGasTokenDecimalsByChain: Readonly<Record<SupportedChain, number>>;
    readonly exactUsdMinProfitRaw: bigint;
    readonly quoteConcurrency: number;
  };
  private readonly activePolls = new Map<SupportedChain, NodeJS.Timeout>();
  private readonly dedupe = new Map<string, number>();
  private readonly usdAsset: Asset = { symbol: "USD", decimals: 8 };

  public constructor(config: ArbitrageScannerConfig) {
    this.config = {
      pollIntervalMs: config.pollIntervalMs ?? 400,
      minProfitMarginBps: config.minProfitMarginBps ?? 120,
      stablePairProbeSize: config.stablePairProbeSize ?? 50_000n,
      volatilePairProbeSize: config.volatilePairProbeSize ?? 10n,
      dedupeWindowMs: config.dedupeWindowMs ?? 60_000,
      baseStableProbeSizes: config.baseStableProbeSizes ?? [10_000n, 25_000n, 50_000n],
      baseStableExpandedProbeSize: config.baseStableExpandedProbeSize ?? 500_000n,
      flashLoanGasEstimate: config.flashLoanGasEstimate ?? 500_000n,
      flashFeeBps: config.flashFeeBps ?? AAVE_V3_BASE_FLASH_FEE_BPS,
      baseMinProfitThreshold: config.baseMinProfitThreshold ?? MIN_PROFIT_THRESHOLD_BNB,
      arbitrageSlippageBps: config.arbitrageSlippageBps ?? 100,
      nativeGasTokenByChain: config.nativeGasTokenByChain ?? {
        optimism: "0x4200000000000000000000000000000000000006",
        arbitrum: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
        base: "0x4200000000000000000000000000000000000006",
      },
      nativeGasTokenDecimalsByChain: config.nativeGasTokenDecimalsByChain ?? {
        optimism: 18,
        arbitrum: 18,
        base: 18,
      },
      exactUsdMinProfitRaw: config.exactUsdMinProfitRaw ?? 15_000_000n,
      quoteConcurrency: Math.max(1, config.quoteConcurrency ?? 4),
      ...config,
    };
  }

  public start(): void {
    const chains = this.config.registry.listChains();
    chains.forEach((chain) => this.startChainPolling(chain));
    this.config.logger.info("arbitrage_scanner_started", {
      chains,
      pollIntervalMs: this.config.pollIntervalMs,
      minProfitMarginBps: this.config.minProfitMarginBps,
    });
  }

  public stop(): void {
    this.activePolls.forEach((t) => clearTimeout(t));
    this.activePolls.clear();
    this.dedupe.clear();
    this.config.logger.info("arbitrage_scanner_stopped");
  }

  public updateMonitoredPairs(_chain: SupportedChain, _pairs: TokenPairConfig[]): void {
    // Source of truth comes from getMonitoredPairsForChain.
  }

  public updateDexes(_chain: SupportedChain, _dexes: DexConfig[]): void {
    // Source of truth comes from getDexesForChain.
  }

  private startChainPolling(chain: SupportedChain): void {
    const poll = async () => {
      try {
        await this.pollChain(chain);
      } catch (error) {
        this.config.metrics.recordError();
        this.config.logger.error("arbitrage_poll_failed", { chain, error: String(error) });
      } finally {
        const timeout = setTimeout(poll, this.config.pollIntervalMs);
        this.activePolls.set(chain, timeout);
      }
    };
    poll();
  }

  private async pollChain(chain: SupportedChain): Promise<void> {
    const startedAt = Date.now();
    const client = this.config.publicClientFactory(chain);
    const dexes = this.config.getDexesForChain(chain);
    const pairs = this.config.getMonitoredPairsForChain(chain);
    this.logDebug("arbitrage_poll_start", {
      chain,
      dexCount: dexes.length,
      pairCount: pairs.length,
    });
    // TODO: Restore original < 2 once PancakeSmartRouter has proper QuoterV2 path
    // (single-DEX is fine for now to unblock Base simulation)
    if (dexes.length < 1 || pairs.length === 0) {
      this.logDebug("arbitrage_poll_skipped", {
        reason: "insufficient_dexes_or_pairs",
        dexCount: dexes.length,
      });
      return;
    }

    let scanned = 0;
    let approvedCount = 0;
    const gasPrice = await this.resolveGasPrice(client);
    if (dexes.length === 1) {
      const onlyDex = dexes[0];
      if (onlyDex === undefined) {
        return;
      }
      scanned = pairs.length;
      const singleResults = await this.runBounded(pairs, async (pair) => {
        const attempt = await this.checkSingleDirection(client, chain, buySell(onlyDex), pair, gasPrice);
        if (attempt !== null && (await this.evaluateOpportunity(attempt)).status === "approved") {
          return 1;
        }
        return 0;
      });
      approvedCount = singleResults.reduce<number>((sum, value) => sum + Number(value), 0);
      this.config.metrics.recordLatency("scan", (Date.now() - startedAt) / 1_000, { chain });
      this.config.metrics.recordArbitrageOpportunityScanned(scanned);
      if (approvedCount > 0) {
        this.config.metrics.recordArbitrageApproved(approvedCount);
        this.config.logger.info("arbitrage_profitable_opportunities_found", { chain, scanned, approved: approvedCount });
      }
      return;
    }
    const routeChecks: Array<{ readonly pair: TokenPairConfig; readonly route: { readonly buyDex: DexConfig; readonly sellDex: DexConfig } }> = [];
    for (const pair of pairs) {
      for (let i = 0; i < dexes.length; i++) {
        for (let j = i + 1; j < dexes.length; j++) {
          const buyDex = dexes[i];
          const sellDex = dexes[j];
          if (buyDex === undefined || sellDex === undefined) {
            continue;
          }
          routeChecks.push({ pair, route: buySell(buyDex, sellDex) });
          routeChecks.push({ pair, route: buySell(sellDex, buyDex) });
        }
      }
    }
    scanned = routeChecks.length;
    const multiResults = await this.runBounded(routeChecks, async ({ pair, route }) => {
      const candidate = await this.checkSingleDirection(client, chain, route, pair, gasPrice);
      if (candidate !== null && (await this.evaluateOpportunity(candidate)).status === "approved") {
        return 1;
      }
      return 0;
    });
    approvedCount = multiResults.reduce<number>((sum, value) => sum + Number(value), 0);

    this.config.metrics.recordLatency("scan", (Date.now() - startedAt) / 1_000, { chain });
    this.config.metrics.recordArbitrageOpportunityScanned(scanned);
    if (approvedCount > 0) {
      this.config.metrics.recordArbitrageApproved(approvedCount);
      this.config.logger.info("arbitrage_profitable_opportunities_found", { chain, scanned, approved: approvedCount });
    }
  }

  private logDebug(message: string, meta?: unknown): void {
    const logger = this.config.logger as DebugCapableLogger;
    if (typeof logger.debug === "function") {
      logger.debug(message, meta);
      return;
    }
    this.config.logger.info(message, meta);
  }

  private async checkSingleDirection(
    client: ReadOnlyClient,
    chain: SupportedChain,
    route: { readonly buyDex: DexConfig; readonly sellDex: DexConfig },
    pair: TokenPairConfig,
    gasPrice: bigint,
  ): Promise<ArbitrageOpportunity | null> {
    try {
      let best: ArbitrageOpportunity | null = null;
      for (const amountIn of this.probeAmountsIn(chain, pair, true)) {
        const intermediate = await this.quoteAmountOut(client, route.buyDex, pair.tokenIn, pair.tokenOut, amountIn);
        const finalAmountOut = await this.quoteAmountOut(client, route.sellDex, pair.tokenOut, pair.tokenIn, intermediate);
        if (finalAmountOut <= amountIn) {
          continue;
        }

        const simulation = await this.simulateCandidatePath(
          client,
          chain,
          route.buyDex,
          route.sellDex,
          pair,
          amountIn,
          intermediate,
          finalAmountOut,
          gasPrice,
        );
        if (!simulation.success) {
          continue;
        }

        const gasEstimate = simulation.gasUsed > 0n ? simulation.gasUsed : this.config.flashLoanGasEstimate;
        const ev = calculateFlashLoanArbitrageEV({
          amountIn,
          amountOutFinal: finalAmountOut,
          flashFeeBps: this.config.flashFeeBps,
          gasEstimate,
          gasPrice,
          slippageBps: this.config.arbitrageSlippageBps,
          minProfitThreshold: this.minProfitThresholdForPair(chain, pair),
        });
        this.logDebug("arbitrage_ev_debug", {
          chain,
          buyDex: route.buyDex.name,
          sellDex: route.sellDex.name,
          pair: `${pair.symbolIn}-${pair.symbolOut}`,
          amountIn: amountIn.toString(),
          rawProfitWei: ev.rawProfitWei.toString(),
          flashFeeWei: ev.flashFeeWei.toString(),
          gasCostWei: ev.gasCostWei.toString(),
          slippageBufferWei: ev.slippageBufferWei.toString(),
          gasEstimate: gasEstimate.toString(),
          isProfitable: ev.isProfitable,
        });
        if (!ev.isProfitable) {
          continue;
        }
        if (this.config.exactUsdPriceCache !== undefined) {
          const exactUsd = await calculateExactUsdEV(
            {
              amountIn,
              amountOutFinal: finalAmountOut,
              flashFeeBps: this.config.flashFeeBps,
              gasEstimate,
              gasPrice,
              slippageBps: this.config.arbitrageSlippageBps,
              minProfitThreshold: this.minProfitThresholdForPair(chain, pair),
              tokenIn: pair.tokenIn,
              tokenInDecimals: pair.decimalsIn,
              nativeGasToken: this.config.nativeGasTokenByChain[chain],
              nativeGasTokenDecimals: this.config.nativeGasTokenDecimalsByChain[chain],
              minProfitUsdRaw: this.config.exactUsdMinProfitRaw,
            },
            this.config.exactUsdPriceCache,
          );
          this.logDebug("arbitrage_exact_usd_ev_debug", {
            chain,
            pair: `${pair.symbolIn}-${pair.symbolOut}`,
            amountIn: amountIn.toString(),
            isPriceAvailable: exactUsd.isPriceAvailable,
            revenueUsdRaw: exactUsd.revenueUsdRaw.toString(),
            costUsdRaw: exactUsd.costUsdRaw.toString(),
            netProfitUsdRaw: exactUsd.netProfitUsdRaw.toString(),
            isProfitable: exactUsd.isProfitable,
          });
          if (exactUsd.isPriceAvailable && !exactUsd.isProfitable) {
            continue;
          }
        }

        const signature = `${chain}:${route.buyDex.name}:${route.sellDex.name}:${pair.symbolIn}-${pair.symbolOut}:${amountIn.toString()}`;
        const now = Date.now();
        this.pruneDedupe(now);
        if (this.dedupe.has(signature)) {
          continue;
        }
        this.dedupe.set(signature, now);

        const revenueRaw = finalAmountOut - amountIn;
        const candidate: ArbitrageOpportunity = {
          chain,
          opportunityId: `arb:${signature}:${now}`,
          buyDex: route.buyDex,
          sellDex: route.sellDex,
          tokenIn: pair.tokenIn,
          tokenOut: pair.tokenOut,
          amountIn,
          expectedIntermediateOut: intermediate,
          expectedAmountOut: finalAmountOut,
          expectedRevenue: tokenAmount(pair, revenueRaw),
          estimatedGas: createAssetAmount(this.usdAsset, gasEstimate),
          flashLoanFee: tokenAmount(pair, (amountIn * BigInt(this.config.flashFeeBps)) / 10_000n),
          slippageBuffer: tokenAmount(pair, (revenueRaw * BigInt(this.config.arbitrageSlippageBps)) / 10_000n),
          safetyBuffer: tokenAmount(pair, (revenueRaw * 50n) / 10_000n),
          capitalAtRisk: tokenAmount(pair, amountIn),
          provider: this.config.defaultFlashLoanProvider,
          minimumMarginBps: this.config.minProfitMarginBps,
        };

        if (best === null || candidate.expectedRevenue.raw > best.expectedRevenue.raw) {
          best = candidate;
        }
      }

      return best;
    } catch (error) {
      this.config.logger.info("arbitrage_quote_failed", {
        chain,
        buyDex: route.buyDex.name,
        sellDex: route.sellDex.name,
        error: String(error),
      });
      return null;
    }
  }

  private async evaluateOpportunity(opp: ArbitrageOpportunity): Promise<ProfitabilityResult> {
    const input: ProfitSimulationInput = {
      chain: opp.chain,
      opportunityId: opp.opportunityId,
      provider: opp.provider,
      revenue: createAssetAmount(this.usdAsset, opp.expectedRevenue.raw),
      debt: createAssetAmount(this.usdAsset, opp.capitalAtRisk.raw),
      gas: opp.estimatedGas,
      flashLoanFee: createAssetAmount(this.usdAsset, opp.flashLoanFee.raw),
      swapCost: createAssetAmount(this.usdAsset, 0n),
      slippageBuffer: createAssetAmount(this.usdAsset, opp.slippageBuffer.raw),
      safetyBuffer: createAssetAmount(this.usdAsset, opp.safetyBuffer.raw),
      capitalAtRisk: createAssetAmount(this.usdAsset, opp.capitalAtRisk.raw),
      minimumMarginBps: opp.minimumMarginBps,
    };
    const result = await this.config.profitabilityEngine.evaluate(input);
    if (result.status === "approved") {
      this.config.metrics.recordNetProfitUsd(Number(result.netProfit.raw) / 10 ** 8);
      this.config.opportunitySink?.push(opp);
      this.config.logger.info("arbitrage_opportunity_approved", {
        opportunityId: opp.opportunityId,
        chain: opp.chain,
        buyDex: opp.buyDex.name,
        sellDex: opp.sellDex.name,
        marginBps: Number(result.marginBps),
        netProfitRaw: result.netProfit.raw.toString(),
      });
    }
    return result;
  }

  private probeAmountIn(pair: TokenPairConfig): bigint {
    const stablePair = pair.symbolIn.startsWith("US") && pair.symbolOut.startsWith("US");
    const units = stablePair ? this.config.stablePairProbeSize : this.config.volatilePairProbeSize;
    return parseUnits(units.toString(), pair.decimalsIn);
  }

  private probeAmountsIn(
    chain: SupportedChain,
    pair: TokenPairConfig,
    includeExpandedProbe: boolean,
  ): readonly bigint[] {
    const stablePair = pair.symbolIn.startsWith("US") && pair.symbolOut.startsWith("US");
    if (!stablePair) {
      const base = this.probeAmountIn(pair);
      return [base, base * 2n, base * 3n, base * 5n];
    }
    if (chain !== "base") {
      return [this.probeAmountIn(pair)];
    }

    const sizes = this.config.baseStableProbeSizes.map((size) => parseUnits(size.toString(), pair.decimalsIn));
    if (!includeExpandedProbe) {
      return sizes;
    }
    return [...sizes, parseUnits(this.config.baseStableExpandedProbeSize.toString(), pair.decimalsIn)];
  }

  private minProfitThresholdForPair(chain: SupportedChain, pair: TokenPairConfig): bigint {
    if (chain !== "base") {
      return MIN_PROFIT_THRESHOLD_WEI;
    }
    if (pair.decimalsIn === 18) {
      return this.config.baseMinProfitThreshold;
    }
    if (pair.decimalsIn > 18) {
      return this.config.baseMinProfitThreshold * (10n ** BigInt(pair.decimalsIn - 18));
    }
    return this.config.baseMinProfitThreshold / (10n ** BigInt(18 - pair.decimalsIn));
  }

  private async resolveGasPrice(client: ReadOnlyClient): Promise<bigint> {
    try {
      return await client.getGasPrice();
    } catch {
      return 1n;
    }
  }

  private async simulateCandidatePath(
    client: ReadOnlyClient,
    chain: SupportedChain,
    buyDex: DexConfig,
    sellDex: DexConfig,
    pair: TokenPairConfig,
    amountIn: bigint,
    intermediate: bigint,
    finalAmountOut: bigint,
    gasPrice: bigint,
  ): Promise<{ readonly success: boolean; readonly gasUsed: bigint }> {
    if (this.config.flashLoanReceiverAddress === undefined || this.config.operatorAddress === undefined) {
      return { success: true, gasUsed: this.config.flashLoanGasEstimate };
    }

    const route = encodeArbitrageRoute({
      buyRouter: buyDex.router,
      sellRouter: sellDex.router,
      tokenIn: pair.tokenIn,
      tokenOut: pair.tokenOut,
      amountIn,
      minBuyOut: intermediate,
      minSellOut: finalAmountOut,
    });
    const data = encodeFunctionData({
      abi: aavePoolAbi,
      functionName: "flashLoanSimple",
      args: [
        this.config.flashLoanReceiverAddress,
        pair.tokenIn,
        amountIn,
        route,
        0,
      ],
    });
    const simulation = await simulateFullFlashLoanArbPath(client, {
      to: aavePoolAddress(chain),
      data,
      from: this.config.operatorAddress,
      gasPrice,
    });
    if (!simulation.success) {
      this.config.logger.info("arbitrage_path_simulation_failed", {
        chain,
        buyDex: buyDex.name,
        sellDex: sellDex.name,
        pair: `${pair.symbolIn}-${pair.symbolOut}`,
        amountIn: amountIn.toString(),
        error: simulation.error,
      });
      return { success: false, gasUsed: 0n };
    }
    return { success: true, gasUsed: simulation.gasUsed };
  }

  private async quoteAmountOut(
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
    this.config.logger.info("arbitrage_quote_debug", {
      dex: dex.name,
      quoteSource,
      tokenIn,
      tokenOut,
      amountIn: amountIn.toString(),
      amountOut: amountOut.toString(),
      ...(quoteSource === "quoterV2" ? { quoterPoolFee: dex.quoterPoolFee ?? 3_000 } : {}),
    });
    return amountOut;
  }

  private pruneDedupe(nowMs: number): void {
    const threshold = nowMs - this.config.dedupeWindowMs;
    for (const [signature, seenAt] of this.dedupe.entries()) {
      if (seenAt < threshold) {
        this.dedupe.delete(signature);
      }
    }
  }

  private async runBounded<TItem, TResult>(
    items: readonly TItem[],
    worker: (item: TItem) => Promise<TResult>,
  ): Promise<TResult[]> {
    const queue = [...items];
    const results: TResult[] = [];
    const workers = Array.from({ length: Math.min(this.config.quoteConcurrency, queue.length) }, async () => {
      while (queue.length > 0) {
        const item = queue.shift();
        if (item === undefined) {
          continue;
        }
        results.push(await worker(item));
      }
    });
    await Promise.all(workers);
    return results;
  }
}

function tokenAmount(pair: TokenPairConfig, raw: bigint): AssetAmount {
  return createAssetAmount({ symbol: pair.symbolIn, decimals: pair.decimalsIn }, raw);
}

function buySell(
  buyDex: DexConfig,
  sellDex?: DexConfig,
): { readonly buyDex: DexConfig; readonly sellDex: DexConfig } {
  return {
    buyDex,
    sellDex: sellDex ?? buyDex,
  };
}

function aavePoolAddress(_chain: SupportedChain): Address {
  return "0x794a61358d6845594f94dc1db02a252b5b4814ad";
}

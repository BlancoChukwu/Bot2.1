import { parseUnits, type Address } from "viem";
import type { BotMetrics, LoggerLike } from "../bot";
import type { ChainRegistry, FlashLoanProviderId } from "../config/chainRegistry";
import type { SupportedChain } from "../config/chains";
import type { Asset, AssetAmount } from "../utils/typedAssetMath";
import { createAssetAmount } from "../utils/typedAssetMath";
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
}

export class ArbitrageScanner {
  private readonly config: ArbitrageScannerConfig & {
    readonly pollIntervalMs: number;
    readonly minProfitMarginBps: number;
    readonly stablePairProbeSize: bigint;
    readonly volatilePairProbeSize: bigint;
    readonly dedupeWindowMs: number;
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
    if (dexes.length < 2 || pairs.length === 0) {
      return;
    }

    let scanned = 0;
    let approvedCount = 0;
    for (const pair of pairs) {
      for (let i = 0; i < dexes.length; i++) {
        for (let j = i + 1; j < dexes.length; j++) {
          const buyDex = dexes[i];
          const sellDex = dexes[j];
          if (buyDex === undefined || sellDex === undefined) {
            continue;
          }
          scanned += 2;

          const first = await this.checkSingleDirection(client, chain, buyDex, sellDex, pair);
          if (first !== null && (await this.evaluateOpportunity(first)).status === "approved") {
            approvedCount += 1;
          }

          const second = await this.checkSingleDirection(client, chain, sellDex, buyDex, pair);
          if (second !== null && (await this.evaluateOpportunity(second)).status === "approved") {
            approvedCount += 1;
          }
        }
      }
    }

    this.config.metrics.recordLatency("scan", (Date.now() - startedAt) / 1_000, { chain });
    this.config.metrics.recordArbitrageOpportunityScanned(scanned);
    if (approvedCount > 0) {
      this.config.metrics.recordArbitrageApproved(approvedCount);
      this.config.logger.info("arbitrage_profitable_opportunities_found", { chain, scanned, approved: approvedCount });
    }
  }

  private async checkSingleDirection(
    client: ReadOnlyClient,
    chain: SupportedChain,
    buyDex: DexConfig,
    sellDex: DexConfig,
    pair: TokenPairConfig,
  ): Promise<ArbitrageOpportunity | null> {
    try {
      const amountIn = this.probeAmountIn(pair);
      const intermediate = await this.quoteAmountOut(client, buyDex, pair.tokenIn, pair.tokenOut, amountIn);
      const finalAmountOut = await this.quoteAmountOut(client, sellDex, pair.tokenOut, pair.tokenIn, intermediate);
      if (finalAmountOut <= amountIn) {
        return null;
      }

      const signature = `${chain}:${buyDex.name}:${sellDex.name}:${pair.symbolIn}-${pair.symbolOut}:${amountIn.toString()}`;
      const now = Date.now();
      this.pruneDedupe(now);
      if (this.dedupe.has(signature)) {
        return null;
      }
      this.dedupe.set(signature, now);

      const revenueRaw = finalAmountOut - amountIn;
      return {
        chain,
        opportunityId: `arb:${signature}:${now}`,
        buyDex,
        sellDex,
        tokenIn: pair.tokenIn,
        tokenOut: pair.tokenOut,
        amountIn,
        expectedAmountOut: finalAmountOut,
        expectedRevenue: tokenAmount(pair, revenueRaw),
        estimatedGas: createAssetAmount(this.usdAsset, 25_000_000n),
        flashLoanFee: tokenAmount(pair, (amountIn * 9n) / 10_000n),
        slippageBuffer: tokenAmount(pair, (revenueRaw * 150n) / 10_000n),
        safetyBuffer: tokenAmount(pair, (revenueRaw * 50n) / 10_000n),
        capitalAtRisk: tokenAmount(pair, amountIn),
        provider: this.config.defaultFlashLoanProvider,
        minimumMarginBps: this.config.minProfitMarginBps,
      };
    } catch (error) {
      this.config.logger.info("arbitrage_quote_failed", {
        chain,
        buyDex: buyDex.name,
        sellDex: sellDex.name,
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
}

function tokenAmount(pair: TokenPairConfig, raw: bigint): AssetAmount {
  return createAssetAmount({ symbol: pair.symbolIn, decimals: pair.decimalsIn }, raw);
}

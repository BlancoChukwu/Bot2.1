import type { Address } from "viem";
import { parseUnits } from "viem";
import type { BotMetrics, LoggerLike } from '../bot';
import type { ChainRegistry, FlashLoanProviderId } from '../config/chainRegistry';
import type { SupportedChain } from "../config/chains";
import type { Asset, AssetAmount } from '../utils/typedAssetMath';
import { createAssetAmount } from "../utils/typedAssetMath";
import { ProfitabilityEngine, type ProfitSimulationInput, type ProfitabilityResult } from '../profitability/profitabilityEngine';

// ─────────────────────────────────────────────────────────────
// Minimal Uniswap V2 / Pancake V2 style router ABI (getAmountsOut)
// Extend with V3 QuoterV2 if you want tick-based precision later
// ─────────────────────────────────────────────────────────────
const ROUTER_ABI = [
  {
    inputs: [
      { name: 'amountIn', type: 'uint256' },
      { name: 'path', type: 'address[]' },
    ],
    name: 'getAmountsOut',
    outputs: [{ name: 'amounts', type: 'uint256[]' }],
    stateMutability: 'view',
    type: 'function',
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

// ─────────────────────────────────────────────────────────────
// Public types – these are what the rest of the bot will consume
// ─────────────────────────────────────────────────────────────
export interface DexConfig {
  readonly name: string;
  readonly router: Address;
  readonly feeBps: number; // 30 = 0.3%
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

// ─────────────────────────────────────────────────────────────
// Config – fully typed and matches the style of the rest of Bot2.1
// ─────────────────────────────────────────────────────────────
export interface ArbitrageScannerConfig {
  readonly registry: ChainRegistry;
  readonly profitabilityEngine: ProfitabilityEngine;
  readonly logger: LoggerLike;
  readonly metrics: BotMetrics;
  readonly publicClientFactory: (chain: SupportedChain) => {
    readContract(args: Record<string, unknown>): Promise<unknown>;
  };
  readonly pollIntervalMs?: number;
  readonly minProfitMarginBps?: number;
  readonly stablePairProbeSize?: bigint;
  readonly volatilePairProbeSize?: bigint;
  readonly defaultFlashLoanProvider: FlashLoanProviderId;
  readonly opportunitySink?: ArbitrageOpportunitySink;
  // User-provided per-chain config (populate in your orchestrator init)
  readonly monitoredPairs: Map<SupportedChain, TokenPairConfig[]>;
  readonly dexesPerChain: Map<SupportedChain, DexConfig[]>;
}

// ─────────────────────────────────────────────────────────────
// The scanner itself – production-grade, profit-first, zero fluff
// ─────────────────────────────────────────────────────────────
export class ArbitrageScanner {
  private readonly config: ArbitrageScannerConfig & {
    readonly pollIntervalMs: number;
    readonly minProfitMarginBps: number;
    readonly stablePairProbeSize: bigint;
    readonly volatilePairProbeSize: bigint;
  };
  private readonly activePolls = new Map<SupportedChain, NodeJS.Timeout>();
  private readonly recentOpportunityIds = new Set<string>(); // simple dedup
  private readonly usdAsset: Asset = { symbol: "USD", decimals: 8 };

  public constructor(config: ArbitrageScannerConfig) {
    this.config = {
      pollIntervalMs: config.pollIntervalMs ?? 400,
      minProfitMarginBps: config.minProfitMarginBps ?? 50, // 0.5% minimum edge
      stablePairProbeSize: config.stablePairProbeSize ?? 50_000n,
      volatilePairProbeSize: config.volatilePairProbeSize ?? 10n,
      ...config,
    };
  }

  public start(): void {
    this.config.registry.listChains().forEach((chain) => this.startChainPolling(chain));
    this.config.logger.info('arbitrage_scanner_started', {
      chains: this.config.registry.listChains(),
      pollIntervalMs: this.config.pollIntervalMs,
      monitoredPairsPerChain: Array.from(this.config.monitoredPairs.entries()).map(([c, p]) => ({
        chain: c,
        count: p.length,
      })),
    });
  }

  public stop(): void {
    this.activePolls.forEach((t) => clearTimeout(t));
    this.activePolls.clear();
    this.recentOpportunityIds.clear();
    this.config.logger.info('arbitrage_scanner_stopped');
  }

  private startChainPolling(chain: SupportedChain): void {
    const poll = async () => {
      try {
        await this.pollChain(chain);
      } catch (error) {
        this.config.metrics.recordError();
        this.config.logger.error('arbitrage_poll_failed', { chain, error: String(error) });
      } finally {
        const timeout = setTimeout(poll, this.config.pollIntervalMs);
        this.activePolls.set(chain, timeout);
      }
    };
    poll(); // kick off immediately
  }

  private async pollChain(chain: SupportedChain): Promise<void> {
    const startedAt = Date.now();
    const client = this.config.publicClientFactory(chain);
    const dexes = this.config.dexesPerChain.get(chain) ?? [];
    const pairs = this.config.monitoredPairs.get(chain) ?? [];

    if (dexes.length < 2 || pairs.length === 0) return;

    let scanned = 0;
    let approvedCount = 0;

    for (const pair of pairs) {
      for (let i = 0; i < dexes.length; i++) {
        for (let j = i + 1; j < dexes.length; j++) {
          scanned += 2;

          // Direction 1: buy on dex i, sell on dex j
          const buyDex = dexes[i];
          const sellDex = dexes[j];
          if (buyDex === undefined || sellDex === undefined) {
            continue;
          }
          const opp1 = await this.checkSingleDirection(client, chain, buyDex, sellDex, pair);
          if (opp1) {
            const result = await this.evaluateOpportunity(opp1);
            if (result.status === 'approved') approvedCount++;
          }

          // Direction 2: buy on dex j, sell on dex i
          const opp2 = await this.checkSingleDirection(client, chain, sellDex, buyDex, pair);
          if (opp2) {
            const result = await this.evaluateOpportunity(opp2);
            if (result.status === 'approved') approvedCount++;
          }
        }
      }
    }

    this.config.metrics.recordLatency("scan", (Date.now() - startedAt) / 1_000, { chain });
    this.config.metrics.recordArbitrageOpportunityScanned(scanned);
    if (approvedCount > 0) {
      this.config.metrics.recordArbitrageApproved(approvedCount);
      this.config.logger.info('arbitrage_profitable_opportunities_found', {
        chain,
        scanned,
        approved: approvedCount,
      });
    }
  }

  private async checkSingleDirection(
    client: { readContract(args: Record<string, unknown>): Promise<unknown> },
    chain: SupportedChain,
    buyDex: DexConfig,
    sellDex: DexConfig,
    pair: TokenPairConfig,
  ): Promise<ArbitrageOpportunity | null> {
    try {
      const amountIn = this.probeAmountIn(pair);

      // Quote 1: buy on buyDex (cheapest path)
      const intermediate = await this.quoteAmountOut(client, buyDex, pair.tokenIn, pair.tokenOut, amountIn);

      // Quote 2: sell on sellDex (highest path)
      const finalAmountOut = await this.quoteAmountOut(client, sellDex, pair.tokenOut, pair.tokenIn, intermediate);

      if (finalAmountOut <= amountIn) return null; // no edge

      // Build opportunity object
      const oppId = `arb:${chain}:${buyDex.name}:${sellDex.name}:${pair.symbolIn}-${pair.symbolOut}:${Date.now()}`;

      // Prevent spam of the exact same opportunity
      if (this.recentOpportunityIds.has(oppId)) return null;
      this.recentOpportunityIds.add(oppId);
      // auto-expire after 60 seconds
      setTimeout(() => this.recentOpportunityIds.delete(oppId), 60_000);

      const revenueRaw = finalAmountOut - amountIn;
      const revenue = tokenAmount(pair, revenueRaw);
      const flashLoanFee = tokenAmount(pair, (amountIn * 9n) / 10_000n);
      const slippageBuffer = tokenAmount(pair, (revenueRaw * 150n) / 10_000n);
      const safetyBuffer = tokenAmount(pair, (revenueRaw * 50n) / 10_000n);
      const capitalAtRisk = tokenAmount(pair, amountIn);
      // Conservative placeholder converted into USD quote units; replaced by preflight estimation.
      const estimatedGasUsd = createAssetAmount(this.usdAsset, 25_000_000n);

      return {
        chain,
        opportunityId: oppId,
        buyDex,
        sellDex,
        tokenIn: pair.tokenIn,
        tokenOut: pair.tokenOut,
        amountIn,
        expectedAmountOut: finalAmountOut,
        expectedRevenue: revenue,
        estimatedGas: estimatedGasUsd,
        flashLoanFee,
        slippageBuffer,
        safetyBuffer,
        capitalAtRisk,
        provider: this.config.defaultFlashLoanProvider,
        minimumMarginBps: this.config.minProfitMarginBps,
      };
    } catch (error) {
      this.config.logger.info("arbitrage_quote_failed", { chain, buyDex: buyDex.name, sellDex: sellDex.name, error: String(error) });
      return null;
    }
  }

  private async evaluateOpportunity(opp: ArbitrageOpportunity): Promise<ProfitabilityResult> {
    // Convert token-denominated opportunity into one quote asset for deterministic checks.
    const quoteRevenue = createAssetAmount(this.usdAsset, opp.expectedRevenue.raw);
    const quoteDebt = createAssetAmount(this.usdAsset, opp.capitalAtRisk.raw);
    const quoteFlashLoanFee = createAssetAmount(this.usdAsset, opp.flashLoanFee.raw);
    const quoteSlippageBuffer = createAssetAmount(this.usdAsset, opp.slippageBuffer.raw);
    const quoteSafetyBuffer = createAssetAmount(this.usdAsset, opp.safetyBuffer.raw);
    const input: ProfitSimulationInput = {
      chain: opp.chain,
      opportunityId: opp.opportunityId,
      provider: opp.provider,
      revenue: quoteRevenue,
      debt: quoteDebt, // flash-loan principal
      gas: opp.estimatedGas,
      flashLoanFee: quoteFlashLoanFee,
      swapCost: createAssetAmount(this.usdAsset, 0n), // refined later via real simulation
      slippageBuffer: quoteSlippageBuffer,
      safetyBuffer: quoteSafetyBuffer,
      capitalAtRisk: quoteDebt,
      minimumMarginBps: opp.minimumMarginBps,
    };

    const result = await this.config.profitabilityEngine.evaluate(input);

    if (result.status === 'approved') {
      this.config.metrics.recordNetProfitUsd(Number(result.netProfit.raw) / 10 ** 8);
      this.config.logger.info('arbitrage_opportunity_approved', {
        opportunityId: opp.opportunityId,
        chain: opp.chain,
        buyDex: opp.buyDex.name,
        sellDex: opp.sellDex.name,
        netProfitRaw: result.netProfit.raw.toString(),
        marginBps: Number(result.marginBps),
        expectedRevenue: opp.expectedRevenue.raw.toString(),
      });
      this.config.opportunitySink?.push(opp);
    } else {
      this.config.logger.info("arbitrage_opportunity_rejected", {
        opportunityId: opp.opportunityId,
        chain: opp.chain,
        reason: result.reason,
        marginBps: Number(result.marginBps),
      });
    }

    return result;
  }

  // Public API for hot-reloading monitored pairs / DEXes at runtime
  public updateMonitoredPairs(chain: SupportedChain, pairs: TokenPairConfig[]): void {
    this.config.monitoredPairs.set(chain, pairs);
  }

  public updateDexes(chain: SupportedChain, dexes: DexConfig[]): void {
    this.config.dexesPerChain.set(chain, dexes);
  }

  private probeAmountIn(pair: TokenPairConfig): bigint {
    const stablePair = pair.symbolIn.startsWith("US") && pair.symbolOut.startsWith("US");
    const units = stablePair ? this.config.stablePairProbeSize : this.config.volatilePairProbeSize;
    return parseUnits(units.toString(), pair.decimalsIn);
  }

  private async quoteAmountOut(
    client: { readContract(args: Record<string, unknown>): Promise<unknown> },
    dex: DexConfig,
    tokenIn: Address,
    tokenOut: Address,
    amountIn: bigint,
  ): Promise<bigint> {
    if (dex.quoterV2 !== undefined) {
      const quote = await client.readContract({
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
      return quote[0];
    }

    const routeAmounts = await client.readContract({
      address: dex.router,
      abi: ROUTER_ABI,
      functionName: "getAmountsOut",
      args: [amountIn, [tokenIn, tokenOut]],
    }) as readonly bigint[];
    const amountOut = routeAmounts[1];
    if (amountOut === undefined) {
      throw new Error("getAmountsOut returned malformed output");
    }
    return amountOut;
  }
}

function tokenAmount(pair: TokenPairConfig, raw: bigint): AssetAmount {
  return createAssetAmount(
    {
      symbol: pair.symbolIn,
      decimals: pair.decimalsIn,
    },
    raw,
  );
}
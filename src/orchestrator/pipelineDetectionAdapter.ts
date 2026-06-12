import type { Address } from "viem";
import type { HealthFactorMonitor } from "../monitors/healthFactorMonitor";
import type { HybridDetectionPipeline } from "../monitors/hybridDetectionPipeline";
import { ArbitrageOpportunityQueue } from "../monitors/arbitrageOpportunityQueue";
import { ReserveAwareBorrowerCache, type BorrowerSnapshot } from "../monitors/reserveAwareBorrowerCache";
import type { LiquidationCandidate } from "../protocols/aaveV3";
import { createAsset, createAssetAmount } from "../utils/typedAssetMath";
import type { CircuitBreakerName, CircuitBreakerState } from "../config/chainRegistry";
import type { SupportedChain } from "../config/chains";
import type { Opportunity } from "../types/opportunity";
import { fromArbitrageOpportunity } from "../types/opportunity";

const usd = createAsset({ symbol: "USD", decimals: 8 });
const weth = createAsset({ symbol: "WETH", decimals: 18 });
const usdc = createAsset({ symbol: "USDC", decimals: 6 });

export interface PipelineDetectionAdapterConfig {
  readonly chain: SupportedChain;
  readonly monitor?: HealthFactorMonitor;
  readonly hybridDetection?: HybridDetectionPipeline;
  readonly arbitrageQueue: ArbitrageOpportunityQueue;
  readonly enableArbitrage?: boolean;
}

export class PipelineDetectionAdapter {
  public readonly cache: ReserveAwareBorrowerCache;

  public constructor(private readonly config: PipelineDetectionAdapterConfig) {
    this.cache = config.hybridDetection?.cache ?? new ReserveAwareBorrowerCache();
  }

  public async start(): Promise<void> {
    if (this.config.hybridDetection !== undefined) {
      await this.config.hybridDetection.start();
      await this.config.hybridDetection.pollFallback(this.config.chain);
      return;
    }
    await this.refreshCandidates();
  }

  public stop(): void {
    this.config.hybridDetection?.stop();
  }

  public async pollFallback(chain: SupportedChain): Promise<void> {
    if (this.config.hybridDetection !== undefined) {
      await this.config.hybridDetection.pollFallback(chain);
      return;
    }
    await this.refreshCandidates();
  }

  public getCircuitBreakerState(chain: SupportedChain, name: CircuitBreakerName): CircuitBreakerState {
    if (this.config.hybridDetection !== undefined) {
      return this.config.hybridDetection.getCircuitBreakerState(chain, name);
    }
    return { status: "closed", failures: 0 };
  }

  public async collectExtraOpportunities(chain: SupportedChain): Promise<readonly Opportunity[]> {
    if (this.config.enableArbitrage === false) {
      return [];
    }
    return this.config.arbitrageQueue.drain(chain).map((candidate) => fromArbitrageOpportunity(candidate));
  }

  private async refreshCandidates(): Promise<void> {
    if (this.config.monitor === undefined) {
      return;
    }
    const candidates = await this.config.monitor.scanOnce();
    for (const candidate of candidates) {
      this.cache.upsert(toSnapshot(this.config.chain, candidate));
    }
  }
}

function toSnapshot(chain: SupportedChain, candidate: LiquidationCandidate): BorrowerSnapshot {
  const debtRaw = candidate.debtToCover;
  const collateralRaw = debtRaw + (debtRaw * BigInt(candidate.liquidationBonusBps)) / 10_000n;
  return {
    chain,
    account: candidate.account,
    protocol: "aave",
    healthFactor: candidate.healthFactor,
    updatedAtMs: Date.now(),
    reserves: [
      {
        assetAddress: candidate.collateralAsset,
        asset: weth,
        collateralBalance: createAssetAmount(weth, collateralRaw),
        variableDebt: createAssetAmount(weth, 0n),
        stableDebt: createAssetAmount(weth, 0n),
        priceInQuote: createAssetAmount(usd, 300_000_000_000n),
        usageAsCollateralEnabled: true,
        liquidationBonusBps: candidate.liquidationBonusBps,
      },
      {
        assetAddress: candidate.debtAsset as Address,
        asset: usdc,
        collateralBalance: createAssetAmount(usdc, 0n),
        variableDebt: createAssetAmount(usdc, debtRaw),
        stableDebt: createAssetAmount(usdc, 0n),
        priceInQuote: createAssetAmount(usd, 100_000_000n),
        usageAsCollateralEnabled: false,
        liquidationBonusBps: 0,
      },
    ],
  };
}

import type { BotMetrics, LoggerLike } from "../bot";
import type { ChainRegistry, FlashLoanProviderId } from "../config/chainRegistry";
import type { SupportedChain } from "../config/chains";
import type { AssetAmount } from "../utils/typedAssetMath";
import {
  ProfitabilityEngine,
  type ProfitabilitySimulator,
  type ProfitSimulationInput,
} from "./profitabilityEngine";

export interface RouteSelectionInput {
  readonly chain: SupportedChain;
  readonly opportunityId: string;
  readonly revenue: AssetAmount;
  readonly debt: AssetAmount;
  readonly gas: AssetAmount;
  readonly swapCost: AssetAmount;
  readonly slippageBuffer: AssetAmount;
  readonly safetyBuffer: AssetAmount;
  readonly capitalAtRisk: AssetAmount;
  readonly minimumMarginBps: number;
}

export type RouteSelectionResult =
  | {
      readonly status: "selected";
      readonly provider: FlashLoanProviderId;
      readonly netProfit: AssetAmount;
      readonly marginBps: bigint;
    }
  | {
      readonly status: "rejected";
      readonly reason: "no_profitable_provider" | "execution_circuit_open";
    };

export interface FlashLoanProviderRouterConfig {
  readonly registry: ChainRegistry;
  readonly logger: LoggerLike;
  readonly metrics: BotMetrics;
  readonly simulator: ProfitabilitySimulator;
  readonly providerFees: Partial<Record<FlashLoanProviderId, AssetAmount>>;
}

export class FlashLoanProviderRouter {
  private readonly engine: ProfitabilityEngine;
  private readonly providerFees: Partial<Record<FlashLoanProviderId, AssetAmount>>;
  private readonly routeCache = new Map<string, { result: RouteSelectionResult; cachedAtMs: number }>();
  private readonly routeCacheTtlMs = 30_000;

  public constructor(private readonly config: FlashLoanProviderRouterConfig) {
    this.providerFees = { ...config.providerFees };
    this.engine = new ProfitabilityEngine(config);
  }

  public setProviderFee(provider: FlashLoanProviderId, fee: AssetAmount): void {
    this.providerFees[provider] = fee;
  }

  public async selectBestRoute(input: RouteSelectionInput): Promise<RouteSelectionResult> {
    const cacheKey = this.cacheKey(input);
    const cached = this.routeCache.get(cacheKey);
    if (cached !== undefined && Date.now() - cached.cachedAtMs < this.routeCacheTtlMs) {
      return cached.result;
    }
    const chain = this.config.registry.get(input.chain);
    if (chain.circuitBreakers.execution.status === "open") {
      this.config.logger.warn("flash_loan_route_rejected", {
        chain: input.chain,
        opportunityId: input.opportunityId,
        reason: "execution_circuit_open",
      });
      const rejected = { status: "rejected", reason: "execution_circuit_open" } as const;
      this.routeCache.set(cacheKey, { result: rejected, cachedAtMs: Date.now() });
      return rejected;
    }

    const approved = [];
    for (const provider of chain.flashLoanProviders) {
      const result = await this.engine.evaluate(this.toSimulationInput(input, provider));
      if (result.status === "approved") {
        approved.push(result);
      }
    }

    const best = approved.sort((left, right) => compareProfitDescending(left.netProfit, right.netProfit))[0];
    if (best === undefined) {
      const rejected = { status: "rejected", reason: "no_profitable_provider" } as const;
      this.routeCache.set(cacheKey, { result: rejected, cachedAtMs: Date.now() });
      return rejected;
    }

    this.config.logger.info("flash_loan_route_selected", {
      chain: input.chain,
      opportunityId: input.opportunityId,
      provider: best.provider,
      netProfitRaw: best.netProfit.raw.toString(),
    });
    const selected = {
      status: "selected",
      provider: best.provider,
      netProfit: best.netProfit,
      marginBps: best.marginBps,
    } as const;
    this.routeCache.set(cacheKey, { result: selected, cachedAtMs: Date.now() });
    return selected;
  }

  public clearRouteCache(): void {
    this.routeCache.clear();
  }

  private toSimulationInput(
    input: RouteSelectionInput,
    provider: FlashLoanProviderId,
  ): ProfitSimulationInput {
    const flashLoanFee = this.providerFees[provider];
    if (flashLoanFee === undefined) {
      throw new Error(`Missing flash-loan fee quote for provider: ${provider}`);
    }

    return {
      ...input,
      provider,
      flashLoanFee,
    };
  }

  private cacheKey(input: RouteSelectionInput): string {
    return [
      input.chain,
      input.opportunityId,
      input.revenue.raw.toString(),
      input.debt.raw.toString(),
      input.gas.raw.toString(),
      input.swapCost.raw.toString(),
      input.slippageBuffer.raw.toString(),
      input.safetyBuffer.raw.toString(),
      input.capitalAtRisk.raw.toString(),
      input.minimumMarginBps.toString(),
    ].join(":");
  }
}

function compareProfitDescending(left: AssetAmount, right: AssetAmount): number {
  if (left.raw === right.raw) {
    return 0;
  }

  return left.raw > right.raw ? -1 : 1;
}

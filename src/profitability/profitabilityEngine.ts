import type { BotMetrics, LoggerLike } from "../bot";
import type { ChainRegistry, FlashLoanProviderId } from "../config/chainRegistry";
import type { SupportedChain } from "../config/chains";
import {
  calculateMarginBps,
  calculateNetProfit,
  meetsMinimumProfitMargin,
  createAssetAmount,
  type AssetAmount,
} from "../utils/typedAssetMath";

export interface ProfitSimulationInput {
  readonly chain: SupportedChain;
  readonly opportunityId: string;
  readonly provider: FlashLoanProviderId;
  readonly revenue: AssetAmount;
  readonly debt: AssetAmount;
  readonly gas: AssetAmount;
  readonly flashLoanFee: AssetAmount;
  readonly swapCost: AssetAmount;
  readonly slippageBuffer: AssetAmount;
  readonly safetyBuffer: AssetAmount;
  readonly capitalAtRisk: AssetAmount;
  readonly minimumMarginBps: number;
}

export interface EthCallSimulationSuccess {
  readonly success: true;
  readonly revenue: AssetAmount;
  readonly gas: AssetAmount;
  readonly swapCost: AssetAmount;
}

export interface EthCallSimulationFailure {
  readonly success: false;
  readonly reason: string;
}

export type EthCallSimulationResult = EthCallSimulationSuccess | EthCallSimulationFailure;

export interface ProfitabilitySimulator {
  simulate(input: ProfitSimulationInput): Promise<EthCallSimulationResult>;
}

export type ProfitabilityResult =
  | {
      readonly status: "approved";
      readonly provider: FlashLoanProviderId;
      readonly netProfit: AssetAmount;
      readonly marginBps: bigint;
    }
  | {
      readonly status: "rejected";
      readonly provider: FlashLoanProviderId;
      readonly reason: "below_min_profit_margin" | "simulation_failed";
      readonly netProfit: AssetAmount;
      readonly marginBps: bigint;
    };

export interface ProfitabilityEngineConfig {
  readonly registry: ChainRegistry;
  readonly simulator: ProfitabilitySimulator;
  readonly logger: LoggerLike;
  readonly metrics: BotMetrics;
}

export class ProfitabilityEngine {
  public constructor(private readonly config: ProfitabilityEngineConfig) {}

  public async evaluate(input: ProfitSimulationInput): Promise<ProfitabilityResult> {
    this.config.registry.get(input.chain);
    const deterministic = this.calculateDeterministicProfit(input);
    if (!this.meetsMargin(deterministic, input)) {
      this.config.logger.info("profitability_precheck_rejected", toLogContext(input, deterministic));
      return this.reject(input, "below_min_profit_margin", deterministic);
    }

    const startedAt = Date.now();
    const simulation = await this.config.simulator.simulate(input);
    this.config.metrics.recordLatency("execution", (Date.now() - startedAt) / 1_000, { chain: input.chain });
    if (!simulation.success) {
      this.config.logger.info("profitability_simulation_rejected", {
        ...toLogContext(input, deterministic),
        reason: simulation.reason,
      });
      return this.reject(input, "simulation_failed", deterministic);
    }

    const simulatedInput: ProfitSimulationInput = {
      ...input,
      revenue: simulation.revenue,
      gas: simulation.gas,
      swapCost: simulation.swapCost,
    };
    const simulated = this.calculateDeterministicProfit(simulatedInput);
    if (!this.meetsMargin(simulated, simulatedInput)) {
      return this.reject(input, "below_min_profit_margin", simulated);
    }

    this.config.logger.info("profitability_approved", toLogContext(input, simulated));
    return {
      status: "approved",
      provider: input.provider,
      netProfit: simulated,
      marginBps: calculateMarginBps(simulated, input.capitalAtRisk),
    };
  }

  private calculateDeterministicProfit(input: ProfitSimulationInput): AssetAmount {
    try {
      return calculateNetProfit({
        revenue: input.revenue,
        debt: input.debt,
        gas: input.gas,
        flashLoanFee: input.flashLoanFee,
        swapCost: input.swapCost,
        slippageBuffer: input.slippageBuffer,
        safetyBuffer: input.safetyBuffer,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("Asset subtraction would be negative")) {
        return createAssetAmount(input.revenue.asset, 0n);
      }
      throw error;
    }
  }

  private meetsMargin(netProfit: AssetAmount, input: ProfitSimulationInput): boolean {
    return meetsMinimumProfitMargin({
      netProfit,
      capitalAtRisk: input.capitalAtRisk,
      minimumMarginBps: input.minimumMarginBps,
    });
  }

  private reject(
    input: ProfitSimulationInput,
    reason: "below_min_profit_margin" | "simulation_failed",
    netProfit: AssetAmount,
  ): ProfitabilityResult {
    return {
      status: "rejected",
      provider: input.provider,
      reason,
      netProfit,
      marginBps: calculateMarginBps(netProfit, input.capitalAtRisk),
    };
  }
}

function toLogContext(input: ProfitSimulationInput, netProfit: AssetAmount): Record<string, unknown> {
  return {
    chain: input.chain,
    opportunityId: input.opportunityId,
    provider: input.provider,
    netProfitRaw: netProfit.raw.toString(),
    marginBps: calculateMarginBps(netProfit, input.capitalAtRisk).toString(),
  };
}

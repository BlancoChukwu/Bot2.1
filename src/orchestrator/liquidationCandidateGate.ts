import type { Address } from "viem";
import type { BotMetrics, LoggerLike } from "../bot";
import type { SupportedChain } from "../config/chains";
import type { LiquidationCandidate } from "../protocols/aaveV3";
import {
  evaluateDustFilter,
  logLiquidationDustDecision,
  computeDebtUsdFromWei,
} from "../protocols/liquidationCandidateFilter";
import type { BorrowerCooldownRegistry } from "../utils/borrowerCooldown";
import { shouldApplyBorrowerCooldown } from "../utils/borrowerCooldownPolicy";
import type { PriceOracleCache } from "../utils/priceOracleCache";
import {
  createReserveAwareCandidates,
  ReserveAwareBorrowerCache,
  type BorrowerSnapshot,
} from "../monitors/reserveAwareBorrowerCache";

const baseUsdcDecimals = 6;
const baseWethDecimals = 18;
const defaultErc20Decimals = 18;

export interface LiquidationCandidateGateConfig {
  readonly minDebtUsd: number;
  readonly resolveGasCostUsd: () => Promise<number>;
  readonly priceOracle?: PriceOracleCache;
  readonly borrowerCooldown: BorrowerCooldownRegistry;
  readonly logger: LoggerLike;
  readonly metrics?: BotMetrics;
  readonly resolveDebtDecimals?: (asset: Address) => number;
}

export class LiquidationCandidateGate {
  public constructor(private readonly config: LiquidationCandidateGateConfig) {}

  public isBorrowerBlocked(chain: SupportedChain, account: Address): boolean {
    if (!this.config.borrowerCooldown.isBorrowerBlocked(chain, account)) {
      return false;
    }
    this.config.metrics?.recordCooldownBlock();
    this.config.logger.info("liquidation_borrower_cooldown_active", {
      chain,
      account,
      remainingMs: this.config.borrowerCooldown.remainingMs(chain, account),
      reason: this.config.borrowerCooldown.lastBlockReason(chain, account),
      message: `cooldown_blocks_total | account: ${account} | remainingMs: ${this.config.borrowerCooldown.remainingMs(chain, account)}`,
    });
    return true;
  }

  public recordDeadLetter(chain: SupportedChain, account: Address, reason: string): void {
    if (!shouldApplyBorrowerCooldown(reason)) {
      return;
    }
    this.config.borrowerCooldown.blockBorrower(chain, account, reason);
  }

  public async filterCandidates(
    chain: SupportedChain,
    candidates: readonly LiquidationCandidate[],
    stage: string,
  ): Promise<LiquidationCandidate[]> {
    const gasCostUsd = await this.config.resolveGasCostUsd();
    const kept: LiquidationCandidate[] = [];
    for (const candidate of candidates) {
      if (this.isBorrowerBlocked(chain, candidate.account)) {
        continue;
      }
      const resolved = await this.resolveFreshDebtUsd(candidate, chain);
      const decision = !resolved.trusted
        ? { debtUsd: resolved.debtUsd, isDust: true, reason: "oracle_untrusted" as const }
        : evaluateDustFilter({
          debtUsd: resolved.debtUsd,
          minDebtUsd: this.config.minDebtUsd,
          gasCostUsd,
        });
      logLiquidationDustDecision(this.config.logger, {
        chain,
        account: candidate.account,
        debtAsset: candidate.debtAsset,
        collateralAsset: candidate.collateralAsset,
        stage,
        decision,
        minDebtUsd: this.config.minDebtUsd,
      });
      if (decision.isDust) {
        this.config.metrics?.recordDustFiltered();
        continue;
      }
      kept.push({
        ...candidate,
        repayValueUsd: resolved.debtUsd,
      });
    }
    return kept;
  }

  /** WS reserve-event path: force-refresh oracle prices before dust evaluation. */
  public async auditBorrowerSnapshots(
    chain: SupportedChain,
    snapshots: readonly BorrowerSnapshot[],
  ): Promise<void> {
    const cache = new ReserveAwareBorrowerCache();
    for (const snapshot of snapshots) {
      cache.upsert(snapshot);
    }
    const candidates = createReserveAwareCandidates(cache, chain);
    if (candidates.length === 0) {
      return;
    }
    await this.filterCandidates(chain, candidates, "ws_reserve_event");
  }

  private async resolveFreshDebtUsd(
    candidate: LiquidationCandidate,
    chain: SupportedChain,
  ): Promise<{ readonly debtUsd: number; readonly trusted: boolean }> {
    if (this.config.priceOracle === undefined) {
      return { debtUsd: candidate.repayValueUsd, trusted: true };
    }
    const prices = await this.config.priceOracle.forceRefreshUsdPrices([
      candidate.debtAsset,
      candidate.collateralAsset,
    ]);
    const debtPrice = prices[candidate.debtAsset] ?? 0n;
    if (debtPrice <= 0n) {
      this.config.logger.error("oracle_price_untrusted_critical", {
        chain,
        account: candidate.account,
        debtAsset: candidate.debtAsset,
        collateralAsset: candidate.collateralAsset,
        message: "forceRefreshUsdPrices returned zero — refusing stale repayValueUsd fallback",
      });
      return { debtUsd: 0, trusted: false };
    }
    const decimals = this.resolveDebtDecimals(candidate.debtAsset);
    return {
      debtUsd: computeDebtUsdFromWei(candidate.debtToCover, decimals, debtPrice),
      trusted: true,
    };
  }

  private resolveDebtDecimals(asset: Address): number {
    if (this.config.resolveDebtDecimals !== undefined) {
      return this.config.resolveDebtDecimals(asset);
    }
    const lower = asset.toLowerCase();
    if (lower.endsWith("833589fcd6edb6e08f4c7c32d4f71b54bda02913")) {
      return baseUsdcDecimals;
    }
    if (lower.endsWith("4200000000000000000000000000000000000006")) {
      return baseWethDecimals;
    }
    return defaultErc20Decimals;
  }
}

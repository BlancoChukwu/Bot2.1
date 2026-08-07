import type { Address } from "viem";
import type { LoggerLike } from "../bot";
import {
  applyCloseFactorToUsd,
  resolveCloseFactorBps,
} from "../config/closeFactor";
import type { PrestageConfig } from "../config/prestageConfig";
import { planUniswapV3LiquidationRoute } from "../config/uniswapV3LiquidationRoutes";
import { encodeLiquidationRoute, type UniswapV3FeeTier } from "../protocols/liquidationFlashLoanReceiver";
import type { LiquidationCandidate } from "../protocols/aaveV3";
import {
  evaluateLiquidationProfitability,
  resolveMinNetProfitFloorUsd,
} from "../profitability/liquidationProfitabilityGate";
import type { LiquidationRejectReason } from "../types/liquidationRejectReason";
import { listPositionsInHfBand } from "./hfBandPositionRanking";
import type { LocalPositionModel } from "./localPositionModel";

const WAD = 1_000_000_000_000_000_000n;
const BPS = 10_000;
const DEFAULT_BONUS_BPS = 500;
const DEFAULT_CONSERVATIVE_SLIPPAGE_BPS = 200;

/**
 * Generation-bump sources that discard the entire cached payload (not quote-only).
 * Enumerate in code comments and on every prestage_invalidate log.
 */
export type PrestageBumpSource =
  | "Borrow"
  | "Repay"
  | "LiquidationCall"
  | "ReserveIndexUpdate"
  | "OracleFeedSwitch"
  | "ConfigReload"
  | "OraclePriceMove"
  | "TtlExpiry"
  | "Manual"
  | "PromoteFail";

export interface PrestageEncodeInputs {
  readonly collateralAsset: Address;
  readonly debtAsset: Address;
  readonly user: Address;
  readonly debtToCover: bigint;
  readonly minDebtOut: bigint;
  readonly fee: UniswapV3FeeTier;
}

export interface PrestageCacheEntry {
  readonly generation: number;
  readonly builtAtMs: number;
  readonly ttlMs: number;
  readonly lastRefreshAtMs: number;
  readonly account: Address;
  readonly hfWad: bigint;
  readonly debtUsd: number;
  readonly collateralUsd: number;
  readonly closeFactorBps: number;
  readonly debtToCover: bigint;
  readonly collateralAsset: Address;
  readonly debtAsset: Address;
  readonly fee: UniswapV3FeeTier;
  readonly quotedAmountOut: bigint;
  readonly expectedBonusUsd: number;
  readonly flashPremiumUsd: number;
  readonly gasEstimateUsd: number;
  readonly finalEV: number;
  readonly selectedPairEv: number;
  readonly nextBestPairEv: number | undefined;
  readonly encodeInputs: PrestageEncodeInputs;
  readonly encodedParams: `0x${string}`;
}

export interface PrestagePairCandidate {
  readonly collateralAsset: Address;
  readonly debtAsset: Address;
  readonly fullDebtUsd: number;
  readonly fullDebtWei: bigint;
  readonly liquidationBonusBps: number;
  readonly collateralReceivedWei?: bigint;
}

export interface PrestageControllerDeps {
  readonly config: PrestageConfig;
  readonly model: LocalPositionModel;
  readonly logger: LoggerLike;
  readonly chain: string;
  readonly resolveGasCostUsd: () => Promise<number>;
  readonly resolveFlashFeeBps: () => Promise<number>;
  readonly minDebtUsd: number;
  readonly minProfitUsd: number;
  /** Optional: load pair candidates for an account (Multicall3 / snapshot). */
  readonly loadPairCandidates?: (account: Address) => Promise<readonly PrestagePairCandidate[]>;
  /** Optional QuoterV2 — only invoked for final top-N. */
  readonly quoteExactInput?: (input: {
    readonly tokenIn: Address;
    readonly tokenOut: Address;
    readonly fee: UniswapV3FeeTier;
    readonly amountIn: bigint;
  }) => Promise<bigint>;
  /** Optional full snapshot refresh — never called on valid-cache promote. */
  readonly refreshBorrowers?: (accounts: readonly Address[]) => Promise<void>;
  /** Cheap HF confirm used on promote. */
  readonly getUserAccountData?: (account: Address) => Promise<{
    readonly healthFactor: bigint;
    readonly totalDebtBase: bigint;
    readonly totalCollateralBase: bigint;
  }>;
  readonly nowMs?: () => number;
}

export interface PrestagePromoteResult {
  readonly cacheHit: boolean;
  readonly reusedPayload: boolean;
  readonly promoteRefresh: boolean;
  readonly freshOracleQuoteOnPromote: boolean;
  readonly entry: PrestageCacheEntry | undefined;
  readonly confirmedHf: number | undefined;
  readonly rejectReason?: LiquidationRejectReason;
  readonly prepAtMs?: number;
  readonly promoteAtMs: number;
  readonly coldRebuild: boolean;
}

/**
 * Prep-only pre-stage controller. Failures never throw into the hot path —
 * callers must wrap tick()/invalidate()/promote() and treat errors as no benefit.
 */
export class PrestageController {
  private readonly cache = new Map<string, PrestageCacheEntry>();
  private generation = 1;
  private killed = false;

  public constructor(private readonly deps: PrestageControllerDeps) {}

  public kill(): void {
    this.killed = true;
  }

  public isKilled(): boolean {
    return this.killed;
  }

  public get(account: Address): PrestageCacheEntry | undefined {
    return this.cache.get(account.toLowerCase());
  }

  public size(): number {
    return this.cache.size;
  }

  /**
   * Discard the entire cached payload for an account (or all accounts).
   * Partial (quote-only) invalidation is forbidden.
   */
  public invalidate(account: Address | undefined, bumpSource: PrestageBumpSource): void {
    if (this.killed) {
      return;
    }
    this.generation += 1;
    if (account === undefined) {
      const cleared = this.cache.size;
      this.cache.clear();
      this.deps.logger.info("prestage_invalidate", {
        chain: this.deps.chain,
        bumpSource,
        generation: this.generation,
        fullEntryDiscarded: true,
        accountsCleared: cleared,
      });
      return;
    }
    const key = account.toLowerCase();
    const had = this.cache.delete(key);
    this.deps.logger.info("prestage_invalidate", {
      chain: this.deps.chain,
      account,
      bumpSource,
      generation: this.generation,
      fullEntryDiscarded: true,
      hadEntry: had,
    });
  }

  /**
   * Selection + opportunistic refresh. Safe to call from flashblock ticks.
   * Cheap approx (no Quoter) → top-N → full Quoter/encode for top-N only.
   */
  public async tick(): Promise<void> {
    if (this.killed || !this.deps.config.enabled) {
      return;
    }
    const now = this.now();
    const band = listPositionsInHfBand({
      model: this.deps.model,
      hfMinWadInclusive: WAD,
      hfMaxWadInclusive: this.deps.config.hfUpperWad,
    });

    const gasCostUsd = await this.deps.resolveGasCostUsd();
    const flashFeeBps = await this.deps.resolveFlashFeeBps();
    const survivors: Array<{
      readonly account: Address;
      readonly debtUsd: number;
      readonly collateralUsd: number;
      readonly hfWad: bigint;
      readonly closeFactorBps: number;
      readonly cappedDebtUsd: number;
      readonly approxEv: number;
    }> = [];

    for (const row of band) {
      const collateralUsd = row.collateralUsd ?? row.debtUsd * 2;
      const closeFactorBps = resolveCloseFactorBps({
        healthFactorWad: row.healthFactorWad,
        collateralUsd,
        debtUsd: row.debtUsd,
      });
      const cappedDebtUsd = applyCloseFactorToUsd(row.debtUsd, closeFactorBps);
      const approx = this.cheapApproxEv({
        cappedDebtUsd,
        gasCostUsd,
        flashFeeBps,
      });
      if (!approx.pass) {
        this.deps.logger.info("prestage_drop", {
          chain: this.deps.chain,
          account: row.account,
          rejectReason: approx.rejectReason,
          debtUsd: row.debtUsd,
          closeFactorBps,
          finalEV: approx.netProfitUsd,
          minProfitUsd: this.deps.minProfitUsd,
          approx: true,
        });
        continue;
      }
      survivors.push({
        account: row.account,
        debtUsd: row.debtUsd,
        collateralUsd,
        hfWad: row.healthFactorWad,
        closeFactorBps,
        cappedDebtUsd,
        approxEv: approx.netProfitUsd,
      });
    }

    survivors.sort((a, b) => b.debtUsd - a.debtUsd);
    const selected = survivors.slice(0, this.deps.config.topN);
    const selectedKeys = new Set(selected.map((s) => s.account.toLowerCase()));

    for (const key of [...this.cache.keys()]) {
      if (!selectedKeys.has(key)) {
        this.cache.delete(key);
      }
    }

    for (const row of selected) {
      await this.refreshAccount(row, gasCostUsd, flashFeeBps, now);
    }
  }

  /**
   * Minimal promote path: getUserAccountData (+ optional quote). Never refreshBorrowers on hit.
   */
  public async promote(account: Address): Promise<PrestagePromoteResult> {
    const promoteAtMs = this.now();
    if (this.killed || !this.deps.config.enabled) {
      return {
        cacheHit: false,
        reusedPayload: false,
        promoteRefresh: false,
        freshOracleQuoteOnPromote: false,
        entry: undefined,
        confirmedHf: undefined,
        coldRebuild: true,
        promoteAtMs,
        rejectReason: "stale_payload",
      };
    }

    const existing = this.get(account);
    this.deps.logger.info("prestage_promote_to_hot", {
      chain: this.deps.chain,
      account,
      cacheHit: existing !== undefined,
      payloadAgeMs: existing === undefined ? undefined : promoteAtMs - existing.builtAtMs,
      generation: existing?.generation,
    });

    if (existing === undefined) {
      return {
        cacheHit: false,
        reusedPayload: false,
        promoteRefresh: false,
        freshOracleQuoteOnPromote: false,
        entry: undefined,
        confirmedHf: undefined,
        coldRebuild: true,
        promoteAtMs,
        rejectReason: "stale_payload",
      };
    }

    if (promoteAtMs - existing.builtAtMs > existing.ttlMs) {
      this.invalidate(account, "TtlExpiry");
      return {
        cacheHit: true,
        reusedPayload: false,
        promoteRefresh: false,
        freshOracleQuoteOnPromote: false,
        entry: undefined,
        confirmedHf: undefined,
        coldRebuild: true,
        promoteAtMs,
        rejectReason: "stale_payload",
        prepAtMs: existing.builtAtMs,
      };
    }

    // Mandatory minimal refresh — never send purely off cached EV.
    let confirmedHf = Number(existing.hfWad) / 1e18;
    let confirmedDebtBase = BigInt(Math.floor(existing.debtUsd * 1e8));
    let confirmedCollateralBase = BigInt(Math.floor(existing.collateralUsd * 1e8));
    if (this.deps.getUserAccountData !== undefined) {
      const data = await this.deps.getUserAccountData(account);
      confirmedHf = Number(data.healthFactor) / 1e18;
      confirmedDebtBase = data.totalDebtBase;
      confirmedCollateralBase = data.totalCollateralBase;
      if (data.healthFactor >= WAD) {
        this.invalidate(account, "PromoteFail");
        return {
          cacheHit: true,
          reusedPayload: false,
          promoteRefresh: true,
          freshOracleQuoteOnPromote: false,
          entry: undefined,
          confirmedHf,
          coldRebuild: true,
          promoteAtMs,
          rejectReason: "hf_not_liquidatable",
          prepAtMs: existing.builtAtMs,
        };
      }
    }

    let freshOracleQuoteOnPromote = false;
    let entry = existing;
    const nearTtl = promoteAtMs - existing.builtAtMs > existing.ttlMs * 0.75;
    if (nearTtl && this.deps.quoteExactInput !== undefined) {
      try {
        const quoted = await this.deps.quoteExactInput({
          tokenIn: existing.collateralAsset,
          tokenOut: existing.debtAsset,
          fee: existing.fee,
          amountIn: existing.encodeInputs.debtToCover, // best-effort; real amount is collateral
        });
        freshOracleQuoteOnPromote = true;
        entry = {
          ...existing,
          quotedAmountOut: quoted,
          lastRefreshAtMs: promoteAtMs,
          encodeInputs: {
            ...existing.encodeInputs,
            minDebtOut: quoted > 0n ? (quoted * 9_800n) / 10_000n : existing.encodeInputs.minDebtOut,
          },
          encodedParams: encodeLiquidationRoute({
            ...existing.encodeInputs,
            minDebtOut: quoted > 0n ? (quoted * 9_800n) / 10_000n : existing.encodeInputs.minDebtOut,
          }),
        };
        this.cache.set(account.toLowerCase(), entry);
      } catch {
        // Keep cached quote; still promote with confirm.
      }
    }
    void confirmedDebtBase;
    void confirmedCollateralBase;

    this.deps.logger.info("prestage_send", {
      chain: this.deps.chain,
      account,
      prepAtMs: entry.builtAtMs,
      promoteAtMs,
      payloadAgeMs: promoteAtMs - entry.builtAtMs,
      reusedPayload: true,
      promoteRefresh: true,
      freshOracleQuoteOnPromote,
      closeFactorBps: entry.closeFactorBps,
      confirmedHf,
      generation: entry.generation,
    });

    return {
      cacheHit: true,
      reusedPayload: true,
      promoteRefresh: true,
      freshOracleQuoteOnPromote,
      entry,
      confirmedHf,
      coldRebuild: false,
      promoteAtMs,
      prepAtMs: entry.builtAtMs,
    };
  }

  private async refreshAccount(
    row: {
      readonly account: Address;
      readonly debtUsd: number;
      readonly collateralUsd: number;
      readonly hfWad: bigint;
      readonly closeFactorBps: number;
      readonly cappedDebtUsd: number;
      readonly approxEv: number;
    },
    gasCostUsd: number,
    flashFeeBps: number,
    now: number,
  ): Promise<void> {
    const key = row.account.toLowerCase();
    const existing = this.cache.get(key);
    if (existing !== undefined) {
      const elapsed = now - existing.lastRefreshAtMs;
      if (elapsed < this.deps.config.minRefreshIntervalMs) {
        this.deps.logger.info("prestage_refresh_backstop", {
          chain: this.deps.chain,
          account: row.account,
          elapsedMs: elapsed,
          minIntervalMs: this.deps.config.minRefreshIntervalMs,
          deferredReason: "min_interval",
        });
        return;
      }
      const age = now - existing.builtAtMs;
      if (age < existing.ttlMs * 0.5) {
        return;
      }
    }

    let rpcCalls = 0;
    const snapshotAge = existing === undefined ? Number.POSITIVE_INFINITY : now - existing.lastRefreshAtMs;
    if (
      this.deps.refreshBorrowers !== undefined
      && snapshotAge > this.deps.config.snapshotRefreshAgeMs
    ) {
      await this.deps.refreshBorrowers([row.account]);
      rpcCalls += 1;
    }

    const pairs = this.deps.loadPairCandidates === undefined
      ? []
      : await this.deps.loadPairCandidates(row.account);
    if (this.deps.loadPairCandidates !== undefined) {
      rpcCalls += 1;
    }

    if (pairs.length === 0) {
      // Synthetic single-pair fallback from band row for unit tests / warm model only.
      const synthetic: PrestagePairCandidate = {
        collateralAsset: "0x4200000000000000000000000000000000000006",
        debtAsset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        fullDebtUsd: row.debtUsd,
        fullDebtWei: BigInt(Math.floor(row.debtUsd * 1e6)),
        liquidationBonusBps: DEFAULT_BONUS_BPS,
      };
      await this.finalizePrep(row, [synthetic], gasCostUsd, flashFeeBps, now, rpcCalls);
      return;
    }
    await this.finalizePrep(row, pairs, gasCostUsd, flashFeeBps, now, rpcCalls);
  }

  private async finalizePrep(
    row: {
      readonly account: Address;
      readonly debtUsd: number;
      readonly collateralUsd: number;
      readonly hfWad: bigint;
      readonly closeFactorBps: number;
      readonly cappedDebtUsd: number;
    },
    pairs: readonly PrestagePairCandidate[],
    gasCostUsd: number,
    flashFeeBps: number,
    now: number,
    rpcCalls: number,
  ): Promise<void> {
    const ranked: Array<{
      readonly pair: PrestagePairCandidate;
      readonly candidate: LiquidationCandidate;
      readonly fee: UniswapV3FeeTier;
      readonly ev: number;
      readonly quotedOut: bigint;
    }> = [];

    for (const pair of pairs) {
      const closeFactorBps = resolveCloseFactorBps({
        healthFactorWad: row.hfWad,
        collateralUsd: row.collateralUsd,
        debtUsd: pair.fullDebtUsd,
      });
      const candidate: LiquidationCandidate = {
        account: row.account,
        collateralAsset: pair.collateralAsset,
        debtAsset: pair.debtAsset,
        debtToCover: (pair.fullDebtWei * BigInt(closeFactorBps)) / 10_000n,
        repayValueUsd: applyCloseFactorToUsd(pair.fullDebtUsd, closeFactorBps),
        liquidationBonusBps: pair.liquidationBonusBps,
        healthFactor: row.hfWad,
        closeFactorBps,
        ...(pair.collateralReceivedWei === undefined
          ? {}
          : {
            collateralReceivedWei:
              (pair.collateralReceivedWei * BigInt(closeFactorBps)) / 10_000n,
          }),
      };
      const plan = planUniswapV3LiquidationRoute({
        candidate,
        minDebtUsd: this.deps.minDebtUsd,
        minProfitUsd: this.deps.minProfitUsd,
        gasCostUsd,
        flashFeeBps,
        slippageBps: DEFAULT_CONSERVATIVE_SLIPPAGE_BPS,
      });
      if (plan.status === "rejected") {
        this.deps.logger.info("prestage_drop", {
          chain: this.deps.chain,
          account: row.account,
          rejectReason: plan.reason as LiquidationRejectReason,
          debtUsd: pair.fullDebtUsd,
          closeFactorBps,
          collateralAsset: pair.collateralAsset,
          debtAsset: pair.debtAsset,
        });
        continue;
      }

      let quotedOut = 0n;
      if (this.deps.quoteExactInput !== undefined) {
        try {
          quotedOut = await this.deps.quoteExactInput({
            tokenIn: plan.candidate.collateralAsset,
            tokenOut: plan.candidate.debtAsset,
            fee: plan.fee,
            amountIn: plan.candidate.collateralReceivedWei ?? plan.candidate.debtToCover,
          });
          rpcCalls += 1;
          if (quotedOut === 0n) {
            this.deps.logger.info("prestage_drop", {
              chain: this.deps.chain,
              account: row.account,
              rejectReason: "quoter_zero" satisfies LiquidationRejectReason,
              debtUsd: plan.candidate.repayValueUsd,
              closeFactorBps,
            });
            continue;
          }
        } catch (error) {
          this.deps.logger.info("prestage_drop", {
            chain: this.deps.chain,
            account: row.account,
            rejectReason: "quoter_revert" satisfies LiquidationRejectReason,
            debtUsd: plan.candidate.repayValueUsd,
            closeFactorBps,
            error: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
      }

      const profitability = evaluateLiquidationProfitability({
        debtUsd: plan.candidate.repayValueUsd,
        liquidationBonusBps: plan.candidate.liquidationBonusBps,
        gasCostUsd,
        flashFeeBps,
        hardFloorUsd: this.deps.minDebtUsd,
        minNetProfitUsd: this.deps.minProfitUsd,
      });
      if (!profitability.pass) {
        this.deps.logger.info("prestage_drop", {
          chain: this.deps.chain,
          account: row.account,
          rejectReason: "ev_below_floor" satisfies LiquidationRejectReason,
          debtUsd: plan.candidate.repayValueUsd,
          closeFactorBps,
          finalEV: profitability.netProfitUsd,
          minProfitUsd: this.deps.minProfitUsd,
        });
        continue;
      }
      ranked.push({
        pair,
        candidate: plan.candidate,
        fee: plan.fee,
        ev: profitability.netProfitUsd,
        quotedOut,
      });
    }

    ranked.sort((a, b) => b.ev - a.ev);
    const best = ranked[0];
    if (best === undefined) {
      return;
    }
    const nextBest = ranked[1];
    const encodeInputs: PrestageEncodeInputs = {
      collateralAsset: best.candidate.collateralAsset,
      debtAsset: best.candidate.debtAsset,
      user: row.account,
      debtToCover: best.candidate.debtToCover,
      minDebtOut: best.quotedOut > 0n ? (best.quotedOut * 9_800n) / 10_000n : 0n,
      fee: best.fee,
    };
    const encodedParams = encodeLiquidationRoute(encodeInputs);
    const flashPremiumUsd = best.candidate.repayValueUsd * (flashFeeBps / BPS);
    const expectedBonusUsd = best.candidate.repayValueUsd * (best.candidate.liquidationBonusBps / BPS);
    const entry: PrestageCacheEntry = {
      generation: this.generation,
      builtAtMs: now,
      ttlMs: this.deps.config.ttlMs,
      lastRefreshAtMs: now,
      account: row.account,
      hfWad: row.hfWad,
      debtUsd: row.debtUsd,
      collateralUsd: row.collateralUsd,
      closeFactorBps: best.candidate.closeFactorBps ?? row.closeFactorBps,
      debtToCover: best.candidate.debtToCover,
      collateralAsset: best.candidate.collateralAsset,
      debtAsset: best.candidate.debtAsset,
      fee: best.fee,
      quotedAmountOut: best.quotedOut,
      expectedBonusUsd,
      flashPremiumUsd,
      gasEstimateUsd: gasCostUsd,
      finalEV: best.ev,
      selectedPairEv: best.ev,
      nextBestPairEv: nextBest?.ev,
      encodeInputs,
      encodedParams,
    };
    this.cache.set(row.account.toLowerCase(), entry);
    this.deps.logger.info("prestage_enter", {
      chain: this.deps.chain,
      account: row.account,
      hfFloat: Number(row.hfWad) / 1e18,
      debtUsd: row.debtUsd,
      closeFactorBps: entry.closeFactorBps,
      debtToCover: entry.debtToCover.toString(),
      expectedBonusUsd,
      flashPremium: flashPremiumUsd,
      gasEstimate: gasCostUsd,
      amountOut: entry.quotedAmountOut.toString(),
      finalEV: best.ev,
      selectedPairEv: best.ev,
      nextBestPairEv: nextBest?.ev,
      generation: entry.generation,
      ttlMs: entry.ttlMs,
    });
    this.deps.logger.info("prestage_refresh", {
      chain: this.deps.chain,
      account: row.account,
      rpcCalls,
      generation: entry.generation,
      reason: "prep",
    });
  }

  private cheapApproxEv(input: {
    readonly cappedDebtUsd: number;
    readonly gasCostUsd: number;
    readonly flashFeeBps: number;
  }): {
    readonly pass: boolean;
    readonly netProfitUsd: number;
    readonly rejectReason: LiquidationRejectReason;
  } {
    // Cheap approx EV must call resolveCloseFactorBps upstream; floors use capped debt only.
    const profitability = evaluateLiquidationProfitability({
      debtUsd: input.cappedDebtUsd,
      liquidationBonusBps: DEFAULT_BONUS_BPS,
      gasCostUsd: input.gasCostUsd,
      flashFeeBps: input.flashFeeBps,
      hardFloorUsd: this.deps.minDebtUsd,
      minNetProfitUsd: this.deps.minProfitUsd,
    });
    const floor = resolveMinNetProfitFloorUsd(input.gasCostUsd, this.deps.minProfitUsd);
    if (input.cappedDebtUsd < this.deps.minDebtUsd) {
      return { pass: false, netProfitUsd: profitability.netProfitUsd, rejectReason: "dust" };
    }
    if (!profitability.pass || profitability.netProfitUsd < floor) {
      return { pass: false, netProfitUsd: profitability.netProfitUsd, rejectReason: "ev_below_floor" };
    }
    return { pass: true, netProfitUsd: profitability.netProfitUsd, rejectReason: "ev_below_floor" };
  }

  private now(): number {
    return this.deps.nowMs?.() ?? Date.now();
  }
}

/** Isolate controller failures from the hot path. */
export async function safePrestageTick(controller: PrestageController, logger: LoggerLike, chain: string): Promise<void> {
  try {
    await controller.tick();
  } catch (error) {
    logger.warn("prestage_tick_failed_isolated", {
      chain,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function safePrestageInvalidate(
  controller: PrestageController,
  account: Address | undefined,
  bumpSource: PrestageBumpSource,
  logger: LoggerLike,
  chain: string,
): Promise<void> {
  try {
    controller.invalidate(account, bumpSource);
  } catch (error) {
    logger.warn("prestage_invalidate_failed_isolated", {
      chain,
      bumpSource,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

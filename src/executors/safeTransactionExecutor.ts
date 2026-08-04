import type { Address, Hash, Hex } from "viem";
import type { BotMetrics, LoggerLike } from "../bot";
import type { ChainRegistry, FlashLoanProviderId } from "../config/chainRegistry";
import type { SupportedChain } from "../config/chains";
import type { RouteSelectionInput, RouteSelectionResult } from "../profitability/flashLoanProviderRouter";
import { resolveLiquidationGasLimit } from "../config/liquidationGasLimits";
import { logFirstAttempt, logOpportunityTrace } from "../observability/opportunityTrace";
import type { LocalNonceManager, NonceReservation } from "./nonceManager";
import type { InFlightExecutionRegistry } from "./inFlightExecutionRegistry";
import type { RecentLiquidationAttemptLedger } from "./recentLiquidationAttemptLedger";

/** Bounded receipt wait — must be ≤ drain bound so shutdown can finish. */
export const EXECUTION_RECEIPT_TIMEOUT_MS = 30_000;
/** Shutdown drain waits at most this long for in-flight executions. */
export const IN_FLIGHT_DRAIN_MAX_MS = 60_000;

export interface TransactionEnvelope {
  readonly to: Address;
  readonly data: Hex;
  readonly provider: FlashLoanProviderId;
  readonly contractCall?: {
    readonly abi: readonly unknown[];
    readonly functionName: string;
    readonly args: readonly unknown[];
  };
}

export interface TransactionOverrides {
  readonly gas: bigint;
  readonly gasPrice: bigint;
  readonly nonce: number;
}

export interface ExecutionPreflightClient {
  estimateGas(transaction: TransactionEnvelope): Promise<bigint>;
  getGasPrice(chain: SupportedChain): Promise<bigint>;
  getPendingNonce(chain: SupportedChain, account: Address): Promise<number>;
  simulateContract(transaction: TransactionEnvelope, overrides: TransactionOverrides): Promise<FinalSimulationResult>;
  send(transaction: TransactionEnvelope, overrides: TransactionOverrides): Promise<Hash>;
  waitForReceipt(hash: Hash): Promise<ExecutionReceipt>;
}

export interface CompetitorRiskAssessment {
  readonly riskBps: number;
  readonly observedCompetitors: number;
}

export interface MempoolCompetitorModel {
  assess(input: {
    readonly request: SafeExecutionRequest;
    readonly transaction: TransactionEnvelope;
    readonly overrides: TransactionOverrides;
  }): Promise<CompetitorRiskAssessment>;
}

export type BundleSubmissionRoute = "public_rpc" | "private_bundle";

export interface DynamicBundleRouter {
  send(input: {
    readonly route: BundleSubmissionRoute;
    readonly request: SafeExecutionRequest;
    readonly transaction: TransactionEnvelope;
    readonly overrides: TransactionOverrides;
    readonly risk: CompetitorRiskAssessment;
  }): Promise<Hash>;
}

export type FinalSimulationResult =
  | { readonly success: true }
  | { readonly success: false; readonly reason: string };

export type ExecutionReceipt =
  | { readonly status: "included" }
  | { readonly status: "underpriced" }
  | { readonly status: "reorged" }
  | { readonly status: "reverted"; readonly reason?: string }
  | { readonly status: "timeout" };

export interface SafeExecutionRequest {
  readonly chain: SupportedChain;
  readonly account: Address;
  readonly opportunityId: string;
  readonly gasProfileKey: string;
  readonly routeInput: RouteSelectionInput;
  readonly gasLimitHint?: {
    readonly collateralAsset: Address;
    readonly debtAsset: Address;
    readonly usesFlashWrapper: boolean;
  };
  readonly flashblockIndex?: number;
  readonly detectionTsMs?: number;
  /** Optional local HF (wad string) for first-attempt observability. */
  readonly localHfWad?: string;
  /** Optional on-chain HF (wad string) for first-attempt observability. */
  readonly chainHfWad?: string;
  buildTransaction(route: SelectedRoute): TransactionEnvelope;
  buildFlashLoanPreviewTransaction?(route: SelectedRoute): TransactionEnvelope;
}

export type SafeExecutionResult =
  | { readonly status: "sent"; readonly txHash: Hash }
  | { readonly status: "simulated" }
  | { readonly status: "rejected"; readonly reason: "route_rejected" | "route_transaction_mismatch" | "final_simulation_failed" | "execution_circuit_open" | "dust_filtered" | "borrower_cooldown" | "recent_attempt_inflight" | "single_opportunity_busy" }
  | { readonly status: "failed"; readonly reason: "receipt_reorged" | "receipt_reverted" | "send_failed" | "receipt_timeout" };

export interface FlashLoanRouteSelector {
  selectBestRoute(input: RouteSelectionInput): Promise<RouteSelectionResult>;
}

export interface SafeTransactionExecutorConfig {
  readonly registry: ChainRegistry;
  readonly router: FlashLoanRouteSelector;
  readonly nonceManager: LocalNonceManager;
  readonly client: ExecutionPreflightClient;
  readonly logger: LoggerLike;
  readonly metrics: BotMetrics;
  readonly replacementBumpBps?: number;
  readonly competitorModel?: MempoolCompetitorModel;
  readonly bundleRouter?: DynamicBundleRouter;
  readonly privateBundleRiskThresholdBps?: number;
  readonly allowPublicFallbackAfterBundleFailure?: boolean;
  readonly privateFirstChains?: readonly SupportedChain[];
  readonly dryRunMode?: boolean;
  readonly rejectBeforePreview?: (request: SafeExecutionRequest) => Promise<string | undefined>;
  readonly rejectBeforeBroadcast?: (request: SafeExecutionRequest) => Promise<string | undefined>;
  readonly inFlightRegistry?: InFlightExecutionRegistry;
  readonly recentAttemptLedger?: RecentLiquidationAttemptLedger;
  readonly quoteExecutionGasCap?: (input: { readonly expectedProfitUsd: number; readonly gasLimit: bigint }) => Promise<{
    readonly maxFeePerGas: bigint;
  }>;
}

interface PreflightResult {
  readonly route: RouteSelectionResult;
  readonly gasPrice: bigint;
  readonly nonce: number;
}

const bpsDenominator = 10_000n;
type SelectedRoute = Extract<RouteSelectionResult, { readonly status: "selected" }>;

export class SafeTransactionExecutor {
  private readonly replacementBumpBps: number;
  private readonly privateBundleRiskThresholdBps: number;
  private readonly privateFirstChains: Set<SupportedChain>;

  public constructor(private readonly config: SafeTransactionExecutorConfig) {
    this.replacementBumpBps = config.replacementBumpBps ?? 1_250;
    this.privateBundleRiskThresholdBps = config.privateBundleRiskThresholdBps ?? 7_000;
    this.privateFirstChains = new Set(config.privateFirstChains ?? []);
  }

  public async execute(request: SafeExecutionRequest): Promise<SafeExecutionResult> {
    const startedAt = Date.now();
    try {
      this.assertRouteMatchesRequest(request);
      const chain = this.config.registry.get(request.chain);
      if (chain.circuitBreakers.execution.status === "open") {
        return { status: "rejected", reason: "execution_circuit_open" };
      }
      // First-live: one opportunity at a time — no parallel flash-loan attempts.
      if ((this.config.inFlightRegistry?.size() ?? 0) > 0) {
        this.config.logger.warn("execution_rejected_single_opportunity_busy", {
          chain: request.chain,
          opportunityId: request.opportunityId,
          inFlight: this.config.inFlightRegistry?.size() ?? 0,
        });
        return { status: "rejected", reason: "single_opportunity_busy" };
      }

      const preflight = await this.runPreflight(request);
      if (preflight.route.status !== "selected") {
        this.releaseNonce(request, preflight.nonce);
        return { status: "rejected", reason: "route_rejected" };
      }
      const transaction = request.buildTransaction(preflight.route);
      if (preflight.route.provider !== transaction.provider) {
        this.releaseNonce(request, preflight.nonce);
        return { status: "rejected", reason: "route_transaction_mismatch" };
      }
      const gas = await this.getGasLimit(request, transaction);

      const gasCapQuote = this.config.quoteExecutionGasCap === undefined
        ? undefined
        : await this.config.quoteExecutionGasCap({
          expectedProfitUsd: Number(preflight.route.netProfit.raw) / 1e8,
          gasLimit: gas,
        });
      const overrides = {
        gas,
        gasPrice: gasCapQuote === undefined
          ? preflight.gasPrice
          : (preflight.gasPrice < gasCapQuote.maxFeePerGas ? preflight.gasPrice : gasCapQuote.maxFeePerGas),
        nonce: preflight.nonce,
      };
      let simulationTsMs: number;
      let dryRun: FinalSimulationResult;
      if (request.buildFlashLoanPreviewTransaction !== undefined) {
        const previewRejectReason = await this.config.rejectBeforePreview?.(request);
        if (previewRejectReason !== undefined) {
          this.releaseNonce(request, preflight.nonce);
          this.config.logger.warn("flash_loan_preview_rejected", {
            chain: request.chain,
            opportunityId: request.opportunityId,
            reason: previewRejectReason,
          });
          if (previewRejectReason === "borrower_cooldown") {
            return { status: "rejected", reason: "borrower_cooldown" };
          }
          const isDustReject = previewRejectReason.startsWith("dust:");
          return { status: "rejected", reason: isDustReject ? "dust_filtered" : "final_simulation_failed" };
        }
        const previewTx = request.buildFlashLoanPreviewTransaction(preflight.route);
        // Preview + final dry-run are independent eth_calls (no shared mutable state).
        simulationTsMs = Date.now();
        const [previewSettled, dryRunSettled] = await Promise.allSettled([
          this.config.client.simulateContract(previewTx, overrides),
          this.config.client.simulateContract(transaction, overrides),
        ]);
        if (previewSettled.status === "rejected") {
          throw previewSettled.reason;
        }
        const preview = previewSettled.value;
        if (!preview.success) {
          this.releaseNonce(request, preflight.nonce);
          this.config.logger.warn("flash_loan_preview_rejected", {
            chain: request.chain,
            opportunityId: request.opportunityId,
            reason: preview.reason,
          });
          return { status: "rejected", reason: "final_simulation_failed" };
        }
        if (dryRunSettled.status === "rejected") {
          throw dryRunSettled.reason;
        }
        dryRun = dryRunSettled.value;
      } else {
        simulationTsMs = Date.now();
        dryRun = await this.config.client.simulateContract(transaction, overrides);
      }
      this.recordPipelineLatency(
        "detection_to_simulation_ms",
        request,
        transaction.provider,
        Date.now() - startedAt,
      );
      if (!dryRun.success) {
        this.releaseNonce(request, preflight.nonce);
        this.config.logger.warn("final_simulation_rejected", {
          chain: request.chain,
          opportunityId: request.opportunityId,
          reason: dryRun.reason,
        });
        logFirstAttempt(this.config.logger, {
          opportunityId: request.opportunityId,
          chain: request.chain,
          account: request.account,
          phase: "simulated",
          simOk: false,
          simRevertReason: dryRun.reason,
          gasEstimate: overrides.gas.toString(),
          ...(request.localHfWad === undefined ? {} : { localHfWad: request.localHfWad }),
          ...(request.chainHfWad === undefined ? {} : { chainHfWad: request.chainHfWad }),
          estProfitAfterFeeGasUsd: Number(preflight.route.netProfit.raw) / 1e8,
        });
        return { status: "rejected", reason: "final_simulation_failed" };
      }
      if (this.config.dryRunMode === true) {
        const wouldSubmitTsMs = Date.now();
        this.recordPipelineLatency(
          "simulation_to_would_submit_ms",
          request,
          transaction.provider,
          wouldSubmitTsMs - simulationTsMs,
        );
        const estProfit = Number(preflight.route.netProfit.raw) / 1e8;
        logOpportunityTrace(this.config.logger, {
          opportunityId: request.opportunityId,
          chain: request.chain,
          ...(request.flashblockIndex === undefined ? {} : { flashblockIndex: request.flashblockIndex }),
          detectionTsMs: request.detectionTsMs ?? startedAt,
          simulationTsMs,
          wouldSubmitTsMs,
          estProfitAfterFeeGasUsd: estProfit,
          simOk: true,
          gasEstimate: overrides.gas.toString(),
          ...(request.localHfWad === undefined ? {} : { localHfWad: request.localHfWad }),
          ...(request.chainHfWad === undefined ? {} : { chainHfWad: request.chainHfWad }),
        });
        logFirstAttempt(this.config.logger, {
          opportunityId: request.opportunityId,
          chain: request.chain,
          account: request.account,
          phase: "simulated",
          simOk: true,
          gasEstimate: overrides.gas.toString(),
          estProfitAfterFeeGasUsd: estProfit,
          ...(request.localHfWad === undefined ? {} : { localHfWad: request.localHfWad }),
          ...(request.chainHfWad === undefined ? {} : { chainHfWad: request.chainHfWad }),
        });
        this.releaseNonce(request, preflight.nonce);
        this.config.logger.info("safe_execution_dry_run_complete", {
          chain: request.chain,
          opportunityId: request.opportunityId,
        });
        return { status: "simulated" };
      }

      this.recordPipelineLatency(
        "detection_to_submit_ms",
        request,
        transaction.provider,
        Date.now() - startedAt,
      );
      const broadcastRejectReason = await this.config.rejectBeforeBroadcast?.(request);
      if (broadcastRejectReason !== undefined) {
        this.releaseNonce(request, preflight.nonce);
        this.config.logger.warn("execution_rejected_hf_not_liquidatable", {
          chain: request.chain,
          opportunityId: request.opportunityId,
          account: request.account,
          reason: broadcastRejectReason,
        });
        return { status: "rejected", reason: "final_simulation_failed" };
      }
      if (await this.isRecentAttemptBlocked(request)) {
        this.releaseNonce(request, preflight.nonce);
        this.config.logger.warn("execution_rejected_recent_attempt_inflight", {
          chain: request.chain,
          opportunityId: request.opportunityId,
          account: request.account,
        });
        return { status: "rejected", reason: "recent_attempt_inflight" };
      }
      return await this.submitWithReplacement(request, transaction, overrides);
    } catch (error) {
      this.config.metrics.recordError();
      throw error;
    } finally {
      this.config.metrics.recordLatency("execution", (Date.now() - startedAt) / 1_000, { chain: request.chain });
    }
  }

  private async runPreflight(request: SafeExecutionRequest): Promise<PreflightResult> {
    const reservationPromise = this.config.nonceManager.reserve(
      request.chain,
      request.account,
      () => this.config.client.getPendingNonce(request.chain, request.account),
    );
    try {
      const [route, gasPrice, reservation] = await Promise.all([
        this.config.router.selectBestRoute(request.routeInput),
        this.config.client.getGasPrice(request.chain),
        reservationPromise,
      ]);

      return { route, gasPrice, nonce: reservation.nonce };
    } catch (error) {
      await this.releaseReservationAfterPreflightFailure(reservationPromise);
      throw error;
    }
  }

  private async getGasLimit(
    request: SafeExecutionRequest,
    transaction: TransactionEnvelope,
  ): Promise<bigint> {
    const cache = this.config.registry.get(request.chain).gasProfileCache;
    const cached = cache.get(request.gasProfileKey);
    if (cached !== undefined) {
      return cached.gasLimit;
    }

    if (request.gasLimitHint !== undefined) {
      const table = resolveLiquidationGasLimit({
        collateralAsset: request.gasLimitHint.collateralAsset,
        debtAsset: request.gasLimitHint.debtAsset,
        provider: transaction.provider,
        usesFlashWrapper: request.gasLimitHint.usesFlashWrapper,
      });
      if (table.fromTable) {
        cache.set(request.gasProfileKey, { gasLimit: table.gasLimit, updatedAtMs: Date.now() });
        return table.gasLimit;
      }
      cache.set(request.gasProfileKey, { gasLimit: table.gasLimit, updatedAtMs: Date.now() });
      this.config.logger.info("liquidation_gas_limit_table_default", {
        chain: request.chain,
        opportunityId: request.opportunityId,
        gasLimit: table.gasLimit.toString(),
        provider: transaction.provider,
      });
      return table.gasLimit;
    }

    this.config.logger.warn("liquidation_gas_estimate_fallback", {
      chain: request.chain,
      opportunityId: request.opportunityId,
      gasProfileKey: request.gasProfileKey,
    });
    this.config.metrics.recordError();
    const gasLimit = await this.config.client.estimateGas(transaction);
    cache.set(request.gasProfileKey, { gasLimit, updatedAtMs: Date.now() });
    return gasLimit;
  }

  private async submitWithReplacement(
    request: SafeExecutionRequest,
    transaction: TransactionEnvelope,
    overrides: TransactionOverrides,
  ): Promise<SafeExecutionResult> {
    const submissionStartedAt = Date.now();
    const firstHash = await this.sendOrReplaceUnderpriced(request, transaction, overrides);
    if (firstHash === undefined) {
      return { status: "failed", reason: "send_failed" };
    }
    await this.onSubmitted(request, firstHash);
    const firstReceipt = await this.config.client.waitForReceipt(firstHash);
    if (firstReceipt.status === "included") {
      await this.onTerminal(request, "included");
      this.recordPipelineLatency(
        "submit_to_inclusion_ms",
        request,
        transaction.provider,
        Date.now() - submissionStartedAt,
      );
      return { status: "sent", txHash: firstHash };
    }
    if (firstReceipt.status === "timeout") {
      await this.onTerminal(request, "timeout");
      return { status: "failed", reason: "receipt_timeout" };
    }
    if (firstReceipt.status === "underpriced") {
      const bumpedOverrides = {
        ...overrides,
        gasPrice: bumpGasPrice(overrides.gasPrice, this.replacementBumpBps),
      };
      const replacementHash = await this.sendReplacement(request, transaction, bumpedOverrides);
      if (replacementHash === undefined) {
        await this.onTerminal(request, "reverted");
        return { status: "failed", reason: "send_failed" };
      }
      this.config.inFlightRegistry?.trackSubmitted(request.opportunityId, replacementHash);
      const replacementReceipt = await this.config.client.waitForReceipt(replacementHash);
      if (replacementReceipt.status === "included") {
        await this.onTerminal(request, "included");
        this.recordPipelineLatency(
          "submit_to_inclusion_ms",
          request,
          transaction.provider,
          Date.now() - submissionStartedAt,
        );
        return { status: "sent", txHash: replacementHash };
      }
      if (replacementReceipt.status === "timeout") {
        await this.onTerminal(request, "timeout");
        return { status: "failed", reason: "receipt_timeout" };
      }
      await this.onTerminal(request, "reverted");
      return toFailedReceipt(replacementReceipt);
    }

    await this.onTerminal(request, "reverted");
    return toFailedReceipt(firstReceipt);
  }

  private async isRecentAttemptBlocked(request: SafeExecutionRequest): Promise<boolean> {
    const ledger = this.config.recentAttemptLedger;
    const hint = request.gasLimitHint;
    if (ledger === undefined || hint === undefined) {
      return false;
    }
    return ledger.isBlocked({
      chain: request.chain,
      account: request.account,
      collateralAsset: hint.collateralAsset,
      debtAsset: hint.debtAsset,
    });
  }

  private async onSubmitted(request: SafeExecutionRequest, txHash: Hash): Promise<void> {
    this.config.inFlightRegistry?.trackSubmitted(request.opportunityId, txHash);
    logFirstAttempt(this.config.logger, {
      opportunityId: request.opportunityId,
      chain: request.chain,
      account: request.account,
      phase: "broadcast",
      broadcastHash: txHash,
      ...(request.localHfWad === undefined ? {} : { localHfWad: request.localHfWad }),
      ...(request.chainHfWad === undefined ? {} : { chainHfWad: request.chainHfWad }),
    });
    const ledger = this.config.recentAttemptLedger;
    const hint = request.gasLimitHint;
    if (ledger === undefined || hint === undefined) {
      return;
    }
    await ledger.recordSubmitted({
      chain: request.chain,
      account: request.account,
      collateralAsset: hint.collateralAsset,
      debtAsset: hint.debtAsset,
      txHash,
    });
  }

  private async onTerminal(
    request: SafeExecutionRequest,
    outcome: "included" | "reverted" | "timeout",
  ): Promise<void> {
    this.config.inFlightRegistry?.complete(request.opportunityId);
    logFirstAttempt(this.config.logger, {
      opportunityId: request.opportunityId,
      chain: request.chain,
      account: request.account,
      phase: "receipt",
      receiptStatus: outcome,
      ...(request.localHfWad === undefined ? {} : { localHfWad: request.localHfWad }),
      ...(request.chainHfWad === undefined ? {} : { chainHfWad: request.chainHfWad }),
    });
    const ledger = this.config.recentAttemptLedger;
    const hint = request.gasLimitHint;
    if (ledger === undefined || hint === undefined) {
      return;
    }
    const key = {
      chain: request.chain,
      account: request.account,
      collateralAsset: hint.collateralAsset,
      debtAsset: hint.debtAsset,
    };
    if (outcome === "included") {
      await ledger.markIncluded(key);
      return;
    }
    // Revert OR receipt timeout: clear block immediately so a real opportunity
    // is not held for the full TTL behind a known failure / unknown outcome.
    await ledger.markReverted(key);
  }

  private async sendOrReplaceUnderpriced(
    request: SafeExecutionRequest,
    transaction: TransactionEnvelope,
    overrides: TransactionOverrides,
  ): Promise<Hash | undefined> {
    try {
      return await this.sendTransaction(request, transaction, overrides);
    } catch (error) {
      if (!isUnderpricedError(error)) {
        this.config.logger.error("transaction_send_failed", {
          chain: request.chain,
          opportunityId: request.opportunityId,
          error,
        });
        await this.resyncNonce(request);
        return undefined;
      }

      const bumpedOverrides = {
        ...overrides,
        gasPrice: bumpGasPrice(overrides.gasPrice, this.replacementBumpBps),
      };
      return this.sendReplacement(request, transaction, bumpedOverrides);
    }
  }

  private async sendReplacement(
    request: SafeExecutionRequest,
    transaction: TransactionEnvelope,
    overrides: TransactionOverrides,
  ): Promise<Hash | undefined> {
    try {
      return await this.sendTransaction(request, transaction, overrides);
    } catch (error) {
      this.config.logger.error("transaction_replacement_failed", {
        chain: request.chain,
        opportunityId: request.opportunityId,
        error,
      });
      await this.resyncNonce(request);
      return undefined;
    }
  }

  private async sendTransaction(
    request: SafeExecutionRequest,
    transaction: TransactionEnvelope,
    overrides: TransactionOverrides,
  ): Promise<Hash> {
    if (this.config.bundleRouter !== undefined && this.privateFirstChains.has(request.chain)) {
      this.config.logger.info("private_bundle_route_forced", {
        chain: request.chain,
        opportunityId: request.opportunityId,
      });
      this.config.metrics.recordBundleSubmission("private_bundle");
      return this.config.bundleRouter.send({
        route: "private_bundle",
        request,
        transaction,
        overrides,
        risk: { riskBps: this.privateBundleRiskThresholdBps, observedCompetitors: 0 },
      }).catch((error) => this.handleBundleFailure(request, transaction, overrides, error));
    }

    const risk = await this.assessCompetitorRisk(request, transaction, overrides);
    if (
      risk !== undefined
      && risk.riskBps >= this.privateBundleRiskThresholdBps
      && this.config.bundleRouter !== undefined
    ) {
      this.config.logger.info("private_bundle_route_selected", {
        chain: request.chain,
        opportunityId: request.opportunityId,
        riskBps: risk.riskBps,
        observedCompetitors: risk.observedCompetitors,
      });
      this.config.metrics.recordBundleSubmission("private_bundle");
      return this.config.bundleRouter.send({
        route: "private_bundle",
        request,
        transaction,
        overrides,
        risk,
      }).catch((error) => this.handleBundleFailure(request, transaction, overrides, error));
    }

    this.config.metrics.recordBundleSubmission("public_rpc");
    return this.config.client.send(transaction, overrides);
  }

  private async handleBundleFailure(
    request: SafeExecutionRequest,
    transaction: TransactionEnvelope,
    overrides: TransactionOverrides,
    error: unknown,
  ): Promise<Hash> {
    this.config.metrics.recordError();
    this.config.logger.error("private_bundle_route_failed", {
      chain: request.chain,
      opportunityId: request.opportunityId,
      error,
    });
    if (this.config.allowPublicFallbackAfterBundleFailure === true) {
      this.config.logger.warn("private_bundle_public_fallback", {
        chain: request.chain,
        opportunityId: request.opportunityId,
      });
      this.config.metrics.recordBundleSubmission("public_rpc");
      return this.config.client.send(transaction, overrides);
    }

    throw error;
  }

  private async assessCompetitorRisk(
    request: SafeExecutionRequest,
    transaction: TransactionEnvelope,
    overrides: TransactionOverrides,
  ): Promise<CompetitorRiskAssessment | undefined> {
    if (this.config.competitorModel === undefined) {
      return undefined;
    }

    try {
      const startedAt = Date.now();
      const risk = await this.config.competitorModel.assess({ request, transaction, overrides });
      this.config.metrics.recordLatency("execution", (Date.now() - startedAt) / 1_000, { chain: request.chain });
      return risk;
    } catch (error) {
      this.config.metrics.recordError();
      this.config.logger.warn("competitor_assessment_failed", {
        chain: request.chain,
        opportunityId: request.opportunityId,
        error,
      });
      return undefined;
    }
  }

  private assertRouteMatchesRequest(request: SafeExecutionRequest): void {
    if (request.chain !== request.routeInput.chain) {
      throw new Error("Execution route chain mismatch");
    }
  }

  private releaseNonce(request: SafeExecutionRequest, nonce: number): void {
    this.config.nonceManager.release({ chain: request.chain, account: request.account, nonce });
  }

  private async releaseReservationAfterPreflightFailure(
    reservationPromise: Promise<NonceReservation>,
  ): Promise<void> {
    const reservation = await reservationPromise.catch(() => undefined);
    if (reservation !== undefined) {
      this.config.nonceManager.release(reservation);
    }
  }

  private async resyncNonce(request: SafeExecutionRequest): Promise<void> {
    const nextNonce = await this.config.client.getPendingNonce(request.chain, request.account);
    this.config.nonceManager.resync(request.chain, request.account, nextNonce);
  }

  private recordPipelineLatency(
    stage:
      | "flashblock_to_detection_ms"
      | "detection_to_simulation_ms"
      | "simulation_to_would_submit_ms"
      | "detection_to_submit_ms"
      | "submit_to_inclusion_ms",
    request: SafeExecutionRequest,
    provider: FlashLoanProviderId,
    durationMs: number,
  ): void {
    this.config.metrics.recordPipelineLatency(stage, durationMs, {
      chain: request.chain,
      provider,
      flashblocks: this.config.registry.get(request.chain).detection.flashblocksEnabled ? "enabled" : "disabled",
    });
  }
}

function bumpGasPrice(gasPrice: bigint, bumpBps: number): bigint {
  return gasPrice + (gasPrice * BigInt(bumpBps)) / bpsDenominator;
}

function toFailedReceipt(receipt: ExecutionReceipt): SafeExecutionResult {
  if (receipt.status === "reorged") {
    return { status: "failed", reason: "receipt_reorged" };
  }
  if (receipt.status === "reverted") {
    return { status: "failed", reason: "receipt_reverted" };
  }
  if (receipt.status === "timeout") {
    return { status: "failed", reason: "receipt_timeout" };
  }

  return { status: "failed", reason: "receipt_reverted" };
}

function isUnderpricedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes("underpriced");
}

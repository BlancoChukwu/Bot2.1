import type { Address, Hash, Hex } from "viem";
import type { BotMetrics, LoggerLike } from "../bot";
import type { ChainRegistry, FlashLoanProviderId } from "../config/chainRegistry";
import type { SupportedChain } from "../config/chains";
import type { RouteSelectionInput, RouteSelectionResult } from "../profitability/flashLoanProviderRouter";
import type { LocalNonceManager, NonceReservation } from "./nonceManager";

export interface TransactionEnvelope {
  readonly to: Address;
  readonly data: Hex;
  readonly provider: FlashLoanProviderId;
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
  simulate(transaction: TransactionEnvelope, overrides: TransactionOverrides): Promise<FinalSimulationResult>;
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
  | { readonly status: "reverted"; readonly reason?: string };

export interface SafeExecutionRequest {
  readonly chain: SupportedChain;
  readonly account: Address;
  readonly opportunityId: string;
  readonly gasProfileKey: string;
  readonly routeInput: RouteSelectionInput;
  buildTransaction(route: SelectedRoute): TransactionEnvelope;
}

export type SafeExecutionResult =
  | { readonly status: "sent"; readonly txHash: Hash }
  | { readonly status: "simulated" }
  | { readonly status: "rejected"; readonly reason: "route_rejected" | "route_transaction_mismatch" | "final_simulation_failed" | "execution_circuit_open" }
  | { readonly status: "failed"; readonly reason: "receipt_reorged" | "receipt_reverted" | "send_failed" };

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
  readonly dryRunMode?: boolean;
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

  public constructor(private readonly config: SafeTransactionExecutorConfig) {
    this.replacementBumpBps = config.replacementBumpBps ?? 1_250;
    this.privateBundleRiskThresholdBps = config.privateBundleRiskThresholdBps ?? 7_000;
  }

  public async execute(request: SafeExecutionRequest): Promise<SafeExecutionResult> {
    const startedAt = Date.now();
    try {
      this.assertRouteMatchesRequest(request);
      const chain = this.config.registry.get(request.chain);
      if (chain.circuitBreakers.execution.status === "open") {
        return { status: "rejected", reason: "execution_circuit_open" };
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

      const overrides = {
        gas,
        gasPrice: preflight.gasPrice,
        nonce: preflight.nonce,
      };
      const dryRun = await this.config.client.simulate(transaction, overrides);
      if (!dryRun.success) {
        this.releaseNonce(request, preflight.nonce);
        this.config.logger.warn("final_simulation_rejected", {
          chain: request.chain,
          opportunityId: request.opportunityId,
          reason: dryRun.reason,
        });
        return { status: "rejected", reason: "final_simulation_failed" };
      }
      if (this.config.dryRunMode === true) {
        this.releaseNonce(request, preflight.nonce);
        this.config.logger.info("safe_execution_dry_run_complete", {
          chain: request.chain,
          opportunityId: request.opportunityId,
        });
        return { status: "simulated" };
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

    const gasLimit = await this.config.client.estimateGas(transaction);
    cache.set(request.gasProfileKey, { gasLimit, updatedAtMs: Date.now() });
    return gasLimit;
  }

  private async submitWithReplacement(
    request: SafeExecutionRequest,
    transaction: TransactionEnvelope,
    overrides: TransactionOverrides,
  ): Promise<SafeExecutionResult> {
    const firstHash = await this.sendOrReplaceUnderpriced(request, transaction, overrides);
    if (firstHash === undefined) {
      return { status: "failed", reason: "send_failed" };
    }
    const firstReceipt = await this.config.client.waitForReceipt(firstHash);
    if (firstReceipt.status === "included") {
      return { status: "sent", txHash: firstHash };
    }
    if (firstReceipt.status === "underpriced") {
      const bumpedOverrides = {
        ...overrides,
        gasPrice: bumpGasPrice(overrides.gasPrice, this.replacementBumpBps),
      };
      const replacementHash = await this.sendReplacement(request, transaction, bumpedOverrides);
      if (replacementHash === undefined) {
        return { status: "failed", reason: "send_failed" };
      }
      const replacementReceipt = await this.config.client.waitForReceipt(replacementHash);
      if (replacementReceipt.status === "included") {
        return { status: "sent", txHash: replacementHash };
      }
      return toFailedReceipt(replacementReceipt);
    }

    return toFailedReceipt(firstReceipt);
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

  return { status: "failed", reason: "receipt_reverted" };
}

function isUnderpricedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes("underpriced");
}

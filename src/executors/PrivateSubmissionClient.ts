import type { Hash } from "viem";
import type { LoggerLike } from "../bot";
import type {
  BundleSubmissionRoute,
  DynamicBundleRouter,
  SafeExecutionRequest,
  TransactionEnvelope,
  TransactionOverrides,
} from "./safeTransactionExecutor";

export type PrivateTxMode = "provider_private" | "sequencer_direct" | "auto";

type SubmissionTarget = "provider_private" | "sequencer_direct";

interface WalletLike {
  sendTransaction(args: Record<string, unknown>): Promise<Hash>;
}

interface PrivateSubmissionClientConfig {
  readonly mode: PrivateTxMode;
  readonly logger: LoggerLike;
  readonly providerPrivateWalletClient?: WalletLike;
  readonly sequencerWalletClient?: WalletLike;
}

type PrivateSendInput = {
  readonly route: BundleSubmissionRoute;
  readonly request: SafeExecutionRequest;
  readonly transaction: TransactionEnvelope;
  readonly overrides: TransactionOverrides;
  readonly risk: { readonly riskBps: number; readonly observedCompetitors: number };
};

type LegOutcome =
  | { readonly target: SubmissionTarget; readonly hash: Hash }
  | { readonly target: SubmissionTarget; readonly error: unknown };

export class PrivateSubmissionClient implements DynamicBundleRouter {
  public constructor(private readonly config: PrivateSubmissionClientConfig) {}

  public async send(input: PrivateSendInput): Promise<Hash> {
    if (input.route !== "private_bundle") {
      throw new Error(`Unsupported private submission route: ${input.route}`);
    }
    if (this.config.mode === "auto") {
      return this.sendAutoRace(input);
    }
    return this.sendSequential(input);
  }

  /** provider_private-only / sequencer_direct-only — unchanged sequential path. */
  private async sendSequential(input: PrivateSendInput): Promise<Hash> {
    const attemptOrder = this.clientOrder();
    for (const target of attemptOrder) {
      const hash = await this.trySubmit(target, input).catch(() => undefined);
      if (hash !== undefined) {
        this.config.logger.info("private_submission_sent", {
          chain: input.request.chain,
          opportunityId: input.request.opportunityId,
          target,
          riskBps: input.risk.riskBps,
        });
        return hash;
      }
    }
    throw new Error("private submission failed across configured targets");
  }

  /**
   * Race both transports with the same reserved nonce. First success wins;
   * the loser self-resolves via nonce conflict — no AbortController.
   */
  private async sendAutoRace(input: PrivateSendInput): Promise<Hash> {
    const targets: readonly SubmissionTarget[] = ["provider_private", "sequencer_direct"];
    const legs: Promise<LegOutcome>[] = targets.map((target) =>
      this.trySubmit(target, input).then(
        (hash): LegOutcome => ({ target, hash }),
        (error: unknown): LegOutcome => ({ target, error }),
      ),
    );

    const winner = await this.awaitFirstSuccessfulLeg(legs);
    this.config.logger.info("private_submission_sent", {
      chain: input.request.chain,
      opportunityId: input.request.opportunityId,
      target: winner.target,
      riskBps: input.risk.riskBps,
    });
    this.logLosingLegWhenSettled(legs, targets, winner, input);
    return winner.hash;
  }

  private awaitFirstSuccessfulLeg(
    legs: readonly Promise<LegOutcome>[],
  ): Promise<{ readonly target: SubmissionTarget; readonly hash: Hash }> {
    return new Promise((resolve, reject) => {
      let failures = 0;
      const reasons: string[] = [];
      for (const leg of legs) {
        void leg.then((outcome) => {
          if ("hash" in outcome) {
            resolve({ target: outcome.target, hash: outcome.hash });
            return;
          }
          failures += 1;
          reasons.push(`${outcome.target}: ${formatSubmissionError(outcome.error)}`);
          if (failures === legs.length) {
            reject(
              new Error(
                `private submission failed across configured targets: ${reasons.join("; ")}`,
              ),
            );
          }
        });
      }
    });
  }

  /**
   * Log the loser's rejection once available without blocking the winner return.
   * Own .catch so a late loser rejection cannot become an unhandled rejection
   * after send() has already returned.
   */
  private logLosingLegWhenSettled(
    legs: readonly Promise<LegOutcome>[],
    targets: readonly SubmissionTarget[],
    winner: { readonly target: SubmissionTarget; readonly hash: Hash },
    input: PrivateSendInput,
  ): void {
    for (let i = 0; i < targets.length; i += 1) {
      const target = targets[i]!;
      if (target === winner.target) {
        continue;
      }
      void legs[i]!
        .then((outcome) => {
          if ("error" in outcome) {
            this.config.logger.warn("private_submission_loser_rejected", {
              chain: input.request.chain,
              opportunityId: input.request.opportunityId,
              winner: winner.target,
              loser: target,
              error: formatSubmissionError(outcome.error),
            });
            return;
          }
          this.config.logger.info("private_submission_loser_also_resolved", {
            chain: input.request.chain,
            opportunityId: input.request.opportunityId,
            winner: winner.target,
            loser: target,
            loserHash: outcome.hash,
          });
        })
        .catch((error: unknown) => {
          this.config.logger.warn("private_submission_loser_log_failed", {
            chain: input.request.chain,
            opportunityId: input.request.opportunityId,
            loser: target,
            error: formatSubmissionError(error),
          });
        });
    }
  }

  private clientOrder(): SubmissionTarget[] {
    if (this.config.mode === "provider_private") {
      return ["provider_private"];
    }
    if (this.config.mode === "sequencer_direct") {
      return ["sequencer_direct"];
    }
    return ["provider_private", "sequencer_direct"];
  }

  private async trySubmit(
    target: SubmissionTarget,
    input: {
      readonly request: SafeExecutionRequest;
      readonly transaction: TransactionEnvelope;
      readonly overrides: TransactionOverrides;
    },
  ): Promise<Hash> {
    const client = target === "provider_private"
      ? this.config.providerPrivateWalletClient
      : this.config.sequencerWalletClient;
    if (client === undefined) {
      throw new Error(`Missing wallet client for ${target}`);
    }
    return client.sendTransaction({
      account: input.request.account,
      to: input.transaction.to,
      data: input.transaction.data,
      gas: input.overrides.gas,
      gasPrice: input.overrides.gasPrice,
      nonce: input.overrides.nonce,
    });
  }
}

function formatSubmissionError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

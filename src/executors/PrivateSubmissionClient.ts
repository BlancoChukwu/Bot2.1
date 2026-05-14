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

interface WalletLike {
  sendTransaction(args: Record<string, unknown>): Promise<Hash>;
}

interface PrivateSubmissionClientConfig {
  readonly mode: PrivateTxMode;
  readonly logger: LoggerLike;
  readonly providerPrivateWalletClient?: WalletLike;
  readonly sequencerWalletClient?: WalletLike;
}

export class PrivateSubmissionClient implements DynamicBundleRouter {
  public constructor(private readonly config: PrivateSubmissionClientConfig) {}

  public async send(input: {
    readonly route: BundleSubmissionRoute;
    readonly request: SafeExecutionRequest;
    readonly transaction: TransactionEnvelope;
    readonly overrides: TransactionOverrides;
    readonly risk: { readonly riskBps: number; readonly observedCompetitors: number };
  }): Promise<Hash> {
    if (input.route !== "private_bundle") {
      throw new Error(`Unsupported private submission route: ${input.route}`);
    }
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

  private clientOrder(): Array<"provider_private" | "sequencer_direct"> {
    if (this.config.mode === "provider_private") {
      return ["provider_private"];
    }
    if (this.config.mode === "sequencer_direct") {
      return ["sequencer_direct"];
    }
    return ["provider_private", "sequencer_direct"];
  }

  private async trySubmit(
    target: "provider_private" | "sequencer_direct",
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

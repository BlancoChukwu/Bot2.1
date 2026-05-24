import type { ExecutionPreflightClient, FinalSimulationResult, TransactionEnvelope, TransactionOverrides } from "./safeTransactionExecutor";
import type { SupportedChain } from "../config/chains";
import { decodeExecutionRevert } from "../utils/revertDecoder";

export interface ViemExecutionClientConfig {
  readonly publicClient: {
    estimateGas(args: Record<string, unknown>): Promise<bigint>;
    getGasPrice(): Promise<bigint>;
    getTransactionCount(args: Record<string, unknown>): Promise<number>;
    call(args: Record<string, unknown>): Promise<unknown>;
    simulateContract?(args: Record<string, unknown>): Promise<unknown>;
    waitForTransactionReceipt(args: Record<string, unknown>): Promise<{ status: "success" | "reverted" }>;
  };
  readonly walletClient: {
    account?: { address: `0x${string}` };
    sendTransaction(args: Record<string, unknown>): Promise<`0x${string}`>;
  };
}

export class ViemExecutionClient implements ExecutionPreflightClient {
  public constructor(private readonly config: ViemExecutionClientConfig) {}

  public async estimateGas(transaction: TransactionEnvelope): Promise<bigint> {
    return this.config.publicClient.estimateGas({
      to: transaction.to,
      data: transaction.data,
      account: this.config.walletClient.account,
    });
  }

  public async getGasPrice(_chain: SupportedChain): Promise<bigint> {
    return this.config.publicClient.getGasPrice();
  }

  public async getPendingNonce(_chain: SupportedChain): Promise<number> {
    return this.config.publicClient.getTransactionCount({
      address: this.requireAccount(),
      blockTag: "pending",
    });
  }

  public async simulateContract(
    transaction: TransactionEnvelope,
    overrides: TransactionOverrides,
  ): Promise<FinalSimulationResult> {
    try {
      if (this.config.publicClient.simulateContract !== undefined && transaction.contractCall !== undefined) {
        await this.config.publicClient.simulateContract({
          account: this.requireAccount(),
          address: transaction.to,
          abi: transaction.contractCall.abi,
          functionName: transaction.contractCall.functionName,
          args: transaction.contractCall.args,
          gas: overrides.gas,
          gasPrice: overrides.gasPrice,
        });
        return { success: true };
      }
      await this.config.publicClient.call({
        account: this.requireAccount(),
        to: transaction.to,
        data: transaction.data,
        gas: overrides.gas,
        gasPrice: overrides.gasPrice,
      });
      return { success: true };
    } catch (error) {
      return { success: false, reason: decodeExecutionRevert(error) };
    }
  }

  public async send(transaction: TransactionEnvelope, overrides: TransactionOverrides): Promise<`0x${string}`> {
    return this.config.walletClient.sendTransaction({
      account: this.requireAccount(),
      chain: undefined,
      to: transaction.to,
      data: transaction.data,
      gas: overrides.gas,
      gasPrice: overrides.gasPrice,
      nonce: overrides.nonce,
    });
  }

  public async waitForReceipt(hash: `0x${string}`): Promise<{ readonly status: "included" | "reverted" }> {
    const receipt = await this.config.publicClient.waitForTransactionReceipt({ hash });
    return receipt.status === "success" ? { status: "included" } : { status: "reverted" };
  }

  private requireAccount(): `0x${string}` {
    const address = this.config.walletClient.account?.address;
    if (address === undefined) {
      throw new Error("Wallet account is required for safe execution client");
    }
    return address;
  }
}

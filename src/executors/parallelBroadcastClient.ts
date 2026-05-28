import type { Hash } from "viem";
import type { LoggerLike } from "../bot";
import type { ExecutionPreflightClient, TransactionEnvelope, TransactionOverrides } from "./safeTransactionExecutor";

export interface ParallelBroadcastClientConfig {
  readonly clients: readonly ExecutionPreflightClient[];
  readonly logger: LoggerLike;
}

/**
 * Signs once (via shared wallet client inside each client) and races eth_sendRawTransaction
 * across all configured RPC endpoints. First successful hash wins.
 */
export class ParallelBroadcastClient implements ExecutionPreflightClient {
  public constructor(private readonly config: ParallelBroadcastClientConfig) {}

  public async estimateGas(transaction: TransactionEnvelope): Promise<bigint> {
    return this.config.clients[0]!.estimateGas(transaction);
  }

  public async getGasPrice(chain: Parameters<ExecutionPreflightClient["getGasPrice"]>[0]): Promise<bigint> {
    const prices = await Promise.all(
      this.config.clients.map((client) => client.getGasPrice(chain).catch(() => undefined)),
    );
    const valid = prices.filter((p): p is bigint => p !== undefined);
    if (valid.length === 0) {
      throw new Error("No RPC returned gas price");
    }
    return valid.reduce((max, p) => (p > max ? p : max), valid[0]!);
  }

  public async getPendingNonce(
    chain: Parameters<ExecutionPreflightClient["getPendingNonce"]>[0],
    account: Parameters<ExecutionPreflightClient["getPendingNonce"]>[1],
  ): Promise<number> {
    return this.config.clients[0]!.getPendingNonce(chain, account);
  }

  public async simulateContract(
    transaction: TransactionEnvelope,
    overrides: TransactionOverrides,
  ) {
    return this.config.clients[0]!.simulateContract(transaction, overrides);
  }

  public async send(transaction: TransactionEnvelope, overrides: TransactionOverrides): Promise<Hash> {
    const attempts = this.config.clients.map(async (client, index) => {
      try {
        const hash = await client.send(transaction, overrides);
        return { index, hash };
      } catch (error) {
        this.config.logger.warn("parallel_broadcast_endpoint_failed", {
          endpointIndex: index,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    });

    const result = await Promise.any(attempts);
    this.config.logger.info("parallel_broadcast_winner", { endpointIndex: result.index, hash: result.hash });
    return result.hash;
  }

  public async waitForReceipt(hash: Hash) {
    return this.config.clients[0]!.waitForReceipt(hash);
  }
}

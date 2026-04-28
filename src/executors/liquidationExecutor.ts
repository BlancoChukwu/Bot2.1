import type { Address, Hash } from "viem";
import {
  aavePoolAbi,
  buildFlashLoanSimpleParams,
  buildLiquidationCallParams,
  type FlashLoanSimpleInput,
  type LiquidationCandidate,
} from "../protocols/aaveV3";
import {
  calculateLiquidationEV,
  calculateLiquidationEv,
  MIN_PROFIT_THRESHOLD_WEI,
} from "../utils/evCalculator";

export type ExecutionResult =
  | { readonly status: "sent"; readonly txHash: Hash; readonly expectedProfitUsd?: number; readonly expectedProfitWei?: bigint }
  | { readonly status: "simulated"; readonly expectedProfitWei: bigint }
  | { readonly status: "skipped"; readonly reason: string; readonly expectedProfitUsd: number }
  | { readonly status: "failed"; readonly reason: string; readonly expectedProfitUsd: number };

export interface TransactionOverrides {
  readonly gas: bigint;
  readonly gasPrice: bigint;
  readonly nonce: number;
}

export interface ExecutorLogger {
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
}

export interface LiquidationExecutorConfig {
  readonly minProfitUsd?: number;
  readonly gasCostUsd?: number;
  readonly slippageBps?: number;
  readonly minProfitWei?: bigint;
  readonly simulationMode?: boolean;
  readonly estimateGas?: (candidate: LiquidationCandidate) => Promise<bigint>;
  readonly getGasPrice?: () => Promise<bigint>;
  readonly getNonce?: () => Promise<number>;
  readonly simulate: (candidate: LiquidationCandidate, overrides?: TransactionOverrides) => Promise<void>;
  readonly send: (candidate: LiquidationCandidate, overrides?: TransactionOverrides) => Promise<Hash>;
  readonly logger?: ExecutorLogger;
}

export interface LiquidationActions {
  readonly simulate: (candidate: LiquidationCandidate, overrides?: TransactionOverrides) => Promise<void>;
  readonly send: (candidate: LiquidationCandidate, overrides?: TransactionOverrides) => Promise<Hash>;
}

export interface LiquidationActionClients {
  readonly pool: Address;
  readonly account: Address;
  readonly publicClient: {
    simulateContract(parameters: LiquidationCallParameters): Promise<unknown>;
  };
  readonly walletClient: {
    writeContract(parameters: LiquidationCallParameters): Promise<Hash>;
  };
}

interface LiquidationCallParameters {
  readonly address: Address;
  readonly abi: typeof aavePoolAbi;
  readonly functionName: "liquidationCall";
  readonly account?: Address;
  readonly gas?: bigint;
  readonly gasPrice?: bigint;
  readonly nonce?: number;
  readonly args: readonly [Address, Address, Address, bigint, boolean];
}

export type FlashLoanRequest = Omit<FlashLoanSimpleInput, "pool">;

export interface FlashLoanActions {
  readonly simulate: (request: FlashLoanRequest) => Promise<void>;
  readonly send: (request: FlashLoanRequest) => Promise<Hash>;
}

export interface FlashLoanActionClients {
  readonly pool: Address;
  readonly account: Address;
  readonly publicClient: {
    simulateContract(parameters: FlashLoanCallParameters): Promise<unknown>;
  };
  readonly walletClient: {
    writeContract(parameters: FlashLoanCallParameters): Promise<Hash>;
  };
}

interface FlashLoanCallParameters {
  readonly address: Address;
  readonly abi: typeof aavePoolAbi;
  readonly functionName: "flashLoanSimple";
  readonly account?: Address;
  readonly args: readonly [Address, Address, bigint, `0x${string}`, number];
}

export function createLiquidationActions(clients: LiquidationActionClients): LiquidationActions {
  return {
    simulate: async (candidate, overrides) => {
      await clients.publicClient.simulateContract(toLiquidationCall(clients, candidate, overrides));
    },
    send: (candidate, overrides) => clients.walletClient.writeContract(toLiquidationCall(clients, candidate, overrides)),
  };
}

export function createFlashLoanActions(clients: FlashLoanActionClients): FlashLoanActions {
  return {
    simulate: async (request) => {
      await clients.publicClient.simulateContract(toFlashLoanCall(clients, request));
    },
    send: (request) => clients.walletClient.writeContract(toFlashLoanCall(clients, request)),
  };
}

export class LiquidationExecutor {
  public constructor(private readonly config: LiquidationExecutorConfig) {}

  public async execute(candidate: LiquidationCandidate): Promise<ExecutionResult> {
    if (this.usesEthEv(candidate)) {
      return this.executeWithEthEv(candidate);
    }

    const ev = calculateLiquidationEv({
      repayValueUsd: candidate.repayValueUsd,
      liquidationBonusBps: candidate.liquidationBonusBps,
      gasCostUsd: this.config.gasCostUsd ?? 0,
      slippageBps: this.config.slippageBps ?? 0,
      minProfitUsd: this.config.minProfitUsd ?? 0,
    });

    if (!ev.isProfitable) {
      return { status: "skipped", reason: "below_min_profit", expectedProfitUsd: ev.expectedProfitUsd };
    }

    return this.simulateAndSend(candidate, ev.expectedProfitUsd);
  }

  private async executeWithEthEv(candidate: LiquidationCandidate): Promise<ExecutionResult> {
    const gasEstimate = await this.getGasEstimate(candidate);
    const gasPrice = await this.getGasPrice();
    const nonce = await this.getNonce();
    const gas = addOptimismGasBuffer(gasEstimate);
    const ev = calculateLiquidationEV(
      candidate.debtToCover,
      candidate.collateralReceivedWei ?? candidate.debtToCover,
      candidate.bonusPercentage ?? candidate.liquidationBonusBps,
      gasEstimate,
      gasPrice,
      this.config.minProfitWei ?? MIN_PROFIT_THRESHOLD_WEI,
    );

    if (!ev.isProfitable) {
      return { status: "skipped", reason: "below_min_profit", expectedProfitUsd: 0 };
    }

    const overrides = { gas, gasPrice, nonce };
    await this.config.simulate(candidate, overrides);

    if (this.config.simulationMode ?? true) {
      this.config.logger?.info(`SIMULATED liquidation of ${candidate.account}`, {
        account: candidate.account,
        expectedProfitWei: ev.profitWei.toString(),
      });
      return { status: "simulated", expectedProfitWei: ev.profitWei };
    }

    const txHash = await this.config.send(candidate, overrides);
    this.config.logger?.info(`EXECUTED liquidation tx: ${txHash}`, {
      account: candidate.account,
      expectedProfitWei: ev.profitWei.toString(),
    });
    return { status: "sent", txHash, expectedProfitWei: ev.profitWei };
  }

  private async simulateAndSend(
    candidate: LiquidationCandidate,
    expectedProfitUsd: number,
  ): Promise<ExecutionResult> {
    try {
      await this.config.simulate(candidate);
      const txHash = await this.config.send(candidate);
      return { status: "sent", txHash, expectedProfitUsd };
    } catch (error) {
      return { status: "failed", reason: toErrorMessage(error), expectedProfitUsd };
    }
  }

  private usesEthEv(candidate: LiquidationCandidate): boolean {
    return this.config.minProfitWei !== undefined
      || candidate.collateralReceivedWei !== undefined
      || candidate.gasEstimate !== undefined
      || candidate.gasPrice !== undefined;
  }

  private async getGasEstimate(candidate: LiquidationCandidate): Promise<bigint> {
    if (this.config.estimateGas !== undefined) {
      return this.config.estimateGas(candidate);
    }

    if (candidate.gasEstimate !== undefined) {
      return candidate.gasEstimate;
    }

    throw new Error("estimateGas is required for ETH-denominated EV execution");
  }

  private async getGasPrice(): Promise<bigint> {
    if (this.config.getGasPrice !== undefined) {
      return this.config.getGasPrice();
    }

    throw new Error("getGasPrice is required for ETH-denominated EV execution");
  }

  private async getNonce(): Promise<number> {
    if (this.config.getNonce !== undefined) {
      return this.config.getNonce();
    }

    throw new Error("getNonce is required for ETH-denominated EV execution");
  }
}

function addOptimismGasBuffer(gasEstimate: bigint): bigint {
  return (gasEstimate * 120n) / 100n;
}

function toLiquidationCall(
  clients: Pick<LiquidationActionClients, "pool" | "account">,
  candidate: LiquidationCandidate,
  overrides?: TransactionOverrides,
): LiquidationCallParameters {
  return {
    ...buildLiquidationCallParams(candidate, clients.pool),
    account: clients.account,
    ...overrides,
  };
}

function toFlashLoanCall(
  clients: Pick<FlashLoanActionClients, "pool" | "account">,
  request: FlashLoanRequest,
): FlashLoanCallParameters {
  return {
    ...buildFlashLoanSimpleParams({ ...request, pool: clients.pool }),
    account: clients.account,
  };
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

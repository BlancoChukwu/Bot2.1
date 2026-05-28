import type { PublicClient } from "viem";

export interface BaseGasQuoteInput {
  readonly client: PublicClient;
  readonly expectedProfitUsd: number;
  readonly gasLimit: bigint;
  readonly maxGasPctOfProfit?: number;
  readonly priorityFeeGwei?: bigint;
}

export interface BaseGasQuote {
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
  readonly gasCostUsd: number;
}

const defaultMaxGasPct = 25;

export async function quoteBaseExecutionGas(input: BaseGasQuoteInput): Promise<BaseGasQuote> {
  const maxPct = input.maxGasPctOfProfit ?? defaultMaxGasPct;
  const block = await input.client.getBlock({ blockTag: "latest" });
  const baseFee = block.baseFeePerGas ?? 0n;
  const priority = input.priorityFeeGwei ?? 1_000_000n;
  const uncappedMax = baseFee * 2n + priority;
  const profitWeiBudget = usdProfitToWeiBudget(input.expectedProfitUsd, maxPct);
  const cappedMax = profitWeiBudget > 0n
    ? minBigint(uncappedMax, profitWeiBudget / input.gasLimit)
    : uncappedMax;
  const maxFeePerGas = cappedMax > priority ? cappedMax : priority + baseFee;
  const ethPriceUsd = 3_000;
  const gasCostUsd = Number(input.gasLimit * maxFeePerGas) / 1e18 * ethPriceUsd;
  return {
    maxFeePerGas,
    maxPriorityFeePerGas: priority,
    gasCostUsd,
  };
}

function usdProfitToWeiBudget(profitUsd: number, maxPct: number): bigint {
  if (profitUsd <= 0) {
    return 0n;
  }
  const eth = (profitUsd * (maxPct / 100)) / 3_000;
  return BigInt(Math.floor(eth * 1e18));
}

function minBigint(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

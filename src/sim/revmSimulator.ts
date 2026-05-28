import type { Address, Hex, PublicClient } from "viem";

export interface RevmSimInput {
  readonly client: PublicClient;
  readonly to: Address;
  readonly data: Hex;
  readonly account: Address;
  readonly blockNumber?: bigint;
  readonly expectedProfitUsd?: number;
}

export interface RevmSimResult {
  readonly success: boolean;
  readonly gasUsed: bigint;
  readonly revertReason?: string;
  readonly source: "revm" | "rpc";
  readonly latencyMs: number;
}

/**
 * REVM path is optional; defaults to eth_call simulation until native NAPI is wired.
 */
export async function simulateWithRevmOrRpc(input: RevmSimInput): Promise<RevmSimResult> {
  const started = Date.now();
  const revmEnabled = (process.env.REVM_SIM_ENABLED ?? "false").trim().toLowerCase() === "true";
  if (revmEnabled) {
    const native = await tryNativeRevm(input);
    if (native !== undefined) {
      return { ...native, latencyMs: Date.now() - started };
    }
  }
  try {
    await input.client.call({
      to: input.to,
      data: input.data,
      account: input.account,
      ...(input.blockNumber === undefined ? {} : { blockNumber: input.blockNumber }),
    });
    return {
      success: true,
      gasUsed: 0n,
      source: "rpc",
      latencyMs: Date.now() - started,
    };
  } catch (error) {
    return {
      success: false,
      gasUsed: 0n,
      revertReason: String(error),
      source: "rpc",
      latencyMs: Date.now() - started,
    };
  }
}

async function tryNativeRevm(_input: RevmSimInput): Promise<Omit<RevmSimResult, "latencyMs"> | undefined> {
  return undefined;
}

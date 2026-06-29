import type { Address, PublicClient } from "viem";
import { aavePoolAbi } from "../protocols/aaveV3";

const WAD = 1_000_000_000_000_000_000n;

export interface LiquidationHfPreflightInput {
  readonly client: PublicClient;
  readonly poolAddress: Address;
  readonly account: Address;
  readonly detectionBlock?: bigint;
}

export type LiquidationHfPreflightResult =
  | { readonly ok: true; readonly healthFactor: bigint; readonly head: bigint }
  | { readonly ok: false; readonly reason: string; readonly healthFactor?: bigint; readonly head?: bigint };

export async function validateLiquidatableHealthFactor(
  input: LiquidationHfPreflightInput,
): Promise<LiquidationHfPreflightResult> {
  const head = await input.client.getBlockNumber();
  if (input.detectionBlock !== undefined && input.detectionBlock < head - 1n) {
    return {
      ok: false,
      reason: "detection_block_stale",
      head,
    };
  }

  const data = await input.client.readContract({
    address: input.poolAddress,
    abi: aavePoolAbi,
    functionName: "getUserAccountData",
    args: [input.account],
  }) as readonly [bigint, bigint, bigint, bigint, bigint, bigint];

  const healthFactor = data[5];
  if (healthFactor >= WAD) {
    return {
      ok: false,
      reason: "hf_not_liquidatable",
      healthFactor,
      head,
    };
  }

  return { ok: true, healthFactor, head };
}

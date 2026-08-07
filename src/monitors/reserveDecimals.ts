import type { Address, PublicClient } from "viem";
import type { LoggerLike } from "../bot";
import type { LocalPositionModel } from "./localPositionModel";

const erc20DecimalsAbi = [
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
] as const;

const MULTICALL_BATCH = 100;

/**
 * Fetches ERC20.decimals() for reserves missing a cached decimals value.
 * Does not invent a default (never assumes 18). Failures leave decimals unset
 * so recomputeHf fails loud on next use.
 */
export async function hydrateReserveDecimals(input: {
  readonly client: PublicClient;
  readonly model: LocalPositionModel;
  readonly assets?: readonly Address[];
  readonly logger?: LoggerLike;
}): Promise<{ readonly hydrated: number; readonly failed: readonly Address[] }> {
  const targets = (input.assets ?? [...input.model.reserveConfig.values()].map((r) => r.asset))
    .filter((asset) => {
      const reserve = input.model.reserveConfig.get(asset.toLowerCase());
      return reserve === undefined || reserve.decimals === undefined;
    });

  if (targets.length === 0) {
    return { hydrated: 0, failed: [] };
  }

  for (const asset of targets) {
    input.model.registerReserve(asset);
  }

  const failed: Address[] = [];
  let hydrated = 0;

  for (let i = 0; i < targets.length; i += MULTICALL_BATCH) {
    const batch = targets.slice(i, i + MULTICALL_BATCH);
    const results = await input.client.multicall({
      contracts: batch.map((asset) => ({
        address: asset,
        abi: erc20DecimalsAbi,
        functionName: "decimals" as const,
      })),
      allowFailure: true,
    });

    for (let j = 0; j < batch.length; j += 1) {
      const asset = batch[j]!;
      const response = results[j];
      if (response?.status !== "success" || typeof response.result !== "number") {
        failed.push(asset);
        input.logger?.error("RESERVE_DECIMALS_FETCH_FAILED", {
          asset,
          error: response?.status === "failure" ? String(response.error) : "invalid_result",
        });
        continue;
      }
      try {
        input.model.setReserveDecimals(asset, response.result);
        hydrated += 1;
      } catch (error) {
        failed.push(asset);
        input.logger?.error("RESERVE_DECIMALS_SET_FAILED", {
          asset,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return { hydrated, failed };
}

export function collectEventReserveAssets(event: {
  readonly reserve: Address;
  readonly collateralAsset?: Address;
  readonly debtAsset?: Address;
}): Address[] {
  const out: Address[] = [event.reserve];
  if (event.collateralAsset !== undefined) {
    out.push(event.collateralAsset);
  }
  if (event.debtAsset !== undefined) {
    out.push(event.debtAsset);
  }
  return out;
}

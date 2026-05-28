import type { Address } from "viem";
import type { FlashLoanProviderId } from "./chainRegistry";

/** Pre-profiled gas limits (+15% buffer). Avoid eth_estimateGas on the hot path. */
const DEFAULT_FLASH_LIQUIDATION_GAS = 1_150_000n;
const DEFAULT_DIRECT_LIQUIDATION_GAS = 650_000n;
const DEFAULT_BALANCER_FLASH_GAS = 1_250_000n;

const pairOverrides = new Map<string, bigint>([
  // Base WETH / USDC flash liquidation (profile on testnet; tune from receipts)
  ["0x4200000000000000000000000000000000000006:0x833589fcd6ede6e08f4c7c32d4f71b54bda02913:aaveV3", 1_100_000n],
  ["0x4200000000000000000000000000000000000006:0x833589fcd6ede6e08f4c7c32d4f71b54bda02913:balancer", 1_200_000n],
]);

export function resolveLiquidationGasLimit(input: {
  readonly collateralAsset: Address;
  readonly debtAsset: Address;
  readonly provider: FlashLoanProviderId;
  readonly usesFlashWrapper: boolean;
}): { readonly gasLimit: bigint; readonly fromTable: boolean } {
  const key = `${input.collateralAsset.toLowerCase()}:${input.debtAsset.toLowerCase()}:${input.provider}`;
  const override = pairOverrides.get(key);
  if (override !== undefined) {
    return { gasLimit: override, fromTable: true };
  }
  if (input.provider === "balancer") {
    return { gasLimit: DEFAULT_BALANCER_FLASH_GAS, fromTable: false };
  }
  if (input.usesFlashWrapper) {
    return { gasLimit: DEFAULT_FLASH_LIQUIDATION_GAS, fromTable: false };
  }
  return { gasLimit: DEFAULT_DIRECT_LIQUIDATION_GAS, fromTable: false };
}

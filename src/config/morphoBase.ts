import type { Address } from "viem";

export interface MorphoBaseConfig {
  readonly morphoBlue: Address;
  readonly preLiquidationFactory?: Address;
}

/**
 * Base Morpho defaults used by scripts and protocol scaffolding.
 * Override by env when addresses rotate.
 */
export const morphoBaseConfig: MorphoBaseConfig = {
  morphoBlue: "0xBBBBBbbBBBBBbBbbBbbBbbbbBBbBbbbbBbBbbBBb",
};


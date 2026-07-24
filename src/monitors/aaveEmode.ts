export const poolEmodeAbi = [
  {
    type: "function",
    name: "getUserEMode",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "getEModeCategoryData",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint8" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "ltv", type: "uint16" },
          { name: "liquidationThreshold", type: "uint16" },
          { name: "liquidationBonus", type: "uint16" },
          { name: "priceSource", type: "address" },
          { name: "label", type: "string" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "getEModeCategoryCollateralBitmap",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint8" }],
    outputs: [{ name: "", type: "uint128" }],
  },
  {
    type: "function",
    name: "getEModeCategoryCollateralConfig",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint8" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "ltv", type: "uint16" },
          { name: "liquidationThreshold", type: "uint16" },
          { name: "liquidationBonus", type: "uint16" },
        ],
      },
    ],
  },
] as const;

export interface EModeCategoryConfig {
  readonly categoryId: number;
  readonly ltvBps: bigint;
  readonly liquidationThresholdBps: bigint;
  readonly liquidationBonus: bigint;
  readonly collateralBitmap: bigint;
}

export function parseEModeCategoryData(
  categoryId: number,
  data: unknown,
  collateralBitmap: bigint,
): EModeCategoryConfig | undefined {
  let ltv: bigint | undefined;
  let liquidationThreshold: bigint | undefined;
  let liquidationBonus: bigint | undefined;

  if (typeof data === "object" && data !== null) {
    const record = data as {
      ltv?: unknown;
      liquidationThreshold?: unknown;
      liquidationBonus?: unknown;
    };
    if (typeof record.ltv === "number" || typeof record.ltv === "bigint") {
      ltv = BigInt(record.ltv);
    }
    if (
      typeof record.liquidationThreshold === "number"
      || typeof record.liquidationThreshold === "bigint"
    ) {
      liquidationThreshold = BigInt(record.liquidationThreshold);
    }
    if (
      typeof record.liquidationBonus === "number"
      || typeof record.liquidationBonus === "bigint"
    ) {
      liquidationBonus = BigInt(record.liquidationBonus);
    }
  }

  if (Array.isArray(data)) {
    if (typeof data[0] === "number" || typeof data[0] === "bigint") {
      ltv = BigInt(data[0]);
    }
    if (typeof data[1] === "number" || typeof data[1] === "bigint") {
      liquidationThreshold = BigInt(data[1]);
    }
    if (typeof data[2] === "number" || typeof data[2] === "bigint") {
      liquidationBonus = BigInt(data[2]);
    }
  }

  if (
    ltv === undefined
    || liquidationThreshold === undefined
    || liquidationBonus === undefined
  ) {
    return undefined;
  }

  return {
    categoryId,
    ltvBps: ltv,
    liquidationThresholdBps: liquidationThreshold,
    liquidationBonus,
    collateralBitmap,
  };
}

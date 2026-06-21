/** Aave v3-origin UserReserveData (stable-rate fields removed in current deployments). */
export const uiPoolDataProviderAbi = [
  {
    type: "function",
    name: "getUserReservesData",
    stateMutability: "view",
    inputs: [
      { name: "provider", type: "address" },
      { name: "user", type: "address" },
    ],
    outputs: [
      {
        name: "",
        type: "tuple[]",
        components: [
          { name: "underlyingAsset", type: "address" },
          { name: "scaledATokenBalance", type: "uint256" },
          { name: "usageAsCollateralEnabledOnUser", type: "bool" },
          { name: "scaledVariableDebt", type: "uint256" },
        ],
      },
      { name: "userEmodeCategoryId", type: "uint8" },
    ],
  },
] as const;

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
          { name: "stableBorrowRate", type: "uint256" },
          { name: "scaledVariableDebt", type: "uint256" },
          { name: "principalStableDebt", type: "uint256" },
          { name: "stableBorrowLastUpdateTimestamp", type: "uint256" },
        ],
      },
      { name: "userEmodeCategoryId", type: "uint8" },
    ],
  },
] as const;

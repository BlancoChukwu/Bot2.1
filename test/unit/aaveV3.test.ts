import { describe, expect, it } from "vitest";
import { getChainConfig } from "../../src/config/chains";
import {
  buildFlashLoanSimpleParams,
  buildLiquidationCallParams,
  calculateHealthFactor,
  getLiquidatablePositions,
  ViemAaveV3Protocol,
} from "../../src/protocols/aaveV3";

describe("ViemAaveV3Protocol", () => {
  it("maps Aave pool account data into a typed user account", async () => {
    const account = "0x0000000000000000000000000000000000000001";
    const protocol = new ViemAaveV3Protocol(
      {
        readContract: async () => [1n, 2n, 3n, 4n, 5n, 6n] as const,
      },
      getChainConfig("optimism"),
    );

    const userAccount = await protocol.getUserAccount(account);

    expect(userAccount).toEqual({
      account,
      totalCollateralBase: 1n,
      totalDebtBase: 2n,
      availableBorrowsBase: 3n,
      currentLiquidationThreshold: 4n,
      loanToValue: 5n,
      healthFactor: 6n,
    });
  });

  it("uses the active chain reserve pair for liquidation candidate fields", async () => {
    const protocol = new ViemAaveV3Protocol(
      {
        readContract: async () => [1n, 2n, 3n, 4n, 5n, 6n] as const,
      },
      getChainConfig("optimism"),
    );

    const pair = await protocol.getBestLiquidationPair({
      account: "0x0000000000000000000000000000000000000001",
      totalCollateralBase: 1n,
      totalDebtBase: 2n,
      availableBorrowsBase: 0n,
      currentLiquidationThreshold: 8_000n,
      loanToValue: 7_500n,
      healthFactor: 900_000_000_000_000_000n,
    });

    expect(pair.collateralAsset).toBe(getChainConfig("optimism").aave.reservePairs[0]?.collateralAsset);
    expect(pair.debtToCover).toBeGreaterThan(0n);
  });

  it("calculates health factor from account debt and threshold", () => {
    const healthFactor = calculateHealthFactor({
      totalCollateralBase: 2_000n,
      totalDebtBase: 1_000n,
      currentLiquidationThreshold: 8_000n,
    });

    expect(healthFactor).toBe(1_600_000_000_000_000_000n);
  });

  it("builds liquidation call params for Aave V3 Pool", () => {
    const params = buildLiquidationCallParams({
      account: "0x0000000000000000000000000000000000000001",
      collateralAsset: "0x0000000000000000000000000000000000000002",
      debtAsset: "0x0000000000000000000000000000000000000003",
      debtToCover: 100n,
      repayValueUsd: 100,
      liquidationBonusBps: 500,
      healthFactor: 900_000_000_000_000_000n,
    }, getChainConfig("optimism").aave.pool);

    expect(params.functionName).toBe("liquidationCall");
    expect(params.args).toEqual([
      "0x0000000000000000000000000000000000000002",
      "0x0000000000000000000000000000000000000003",
      "0x0000000000000000000000000000000000000001",
      100n,
      false,
    ]);
  });

  it("builds Aave flashLoanSimple params for a receiver contract", () => {
    const params = buildFlashLoanSimpleParams({
      pool: getChainConfig("optimism").aave.pool,
      receiverAddress: "0x0000000000000000000000000000000000000004",
      asset: "0x0000000000000000000000000000000000000003",
      amount: 100n,
      encodedParams: "0x1234",
      referralCode: 0,
    });

    expect(params.functionName).toBe("flashLoanSimple");
    expect(params.args[1]).toBe("0x0000000000000000000000000000000000000003");
  });

  it("discovers all subgraph borrowers and returns only on-chain liquidatable positions", async () => {
    const chain = getChainConfig("optimism");
    const readAccounts: string[] = [];

    const positions = await getLiquidatablePositions({
      chain,
      pageSize: 2,
      graphClient: {
        request: async <T>(_query: string, variables: Record<string, number>): Promise<T> => {
          if (variables.skip === 0) {
            return {
              positions: [
                { account: { id: "0x0000000000000000000000000000000000000001" } },
                { account: { id: "0x0000000000000000000000000000000000000002" } },
              ],
            } as T;
          }

          return { positions: [] } as T;
        },
      },
      publicClient: {
        readContract: async ({ args }) => {
          readAccounts.push(args[0]);
          const isLiquidatable = args[0].endsWith("1");
          return [
            2_000n,
            1_000n,
            0n,
            isLiquidatable ? 4_000n : 8_000n,
            7_500n,
            isLiquidatable ? 800_000_000_000_000_000n : 1_600_000_000_000_000_000n,
          ] as const;
        },
      },
    });

    expect(readAccounts).toHaveLength(2);
    expect(positions).toHaveLength(1);
    expect(positions[0]?.account).toBe("0x0000000000000000000000000000000000000001");
  });

  it("falls back to legacy `users` paging when the subgraph has no `positions` field", async () => {
    const chain = getChainConfig("optimism");
    const readAccounts: string[] = [];
    let callCount = 0;

    const positions = await getLiquidatablePositions({
      chain,
      pageSize: 2,
      graphClient: {
        request: async <T>(query: string, variables: Record<string, number>): Promise<T> => {
          callCount += 1;
          if (query.includes("positions") && variables.skip === 0) {
            throw new Error(
              'Aave subgraph GraphQL errors: [{"message":"Type `Query` has no field `positions`"}]',
            );
          }
          if (query.includes("users") && variables.skip === 0) {
            return {
              users: [{ id: "0x0000000000000000000000000000000000000001" }, { id: "0x0000000000000000000000000000000000000002" }],
            } as T;
          }
          if (query.includes("users") && variables.skip === 2) {
            return { users: [] } as T;
          }
          throw new Error(`unexpected query in test: ${query.slice(0, 40)}`);
        },
      },
      publicClient: {
        readContract: async ({ args }) => {
          readAccounts.push(args[0]);
          const isLiquidatable = args[0].endsWith("1");
          return [
            2_000n,
            1_000n,
            0n,
            isLiquidatable ? 4_000n : 8_000n,
            7_500n,
            isLiquidatable ? 800_000_000_000_000_000n : 1_600_000_000_000_000_000n,
          ] as const;
        },
      },
    });

    expect(callCount).toBeGreaterThanOrEqual(2);
    expect(readAccounts).toHaveLength(2);
    expect(positions).toHaveLength(1);
    expect(positions[0]?.account).toBe("0x0000000000000000000000000000000000000001");
  });

  it("derives borrower addresses from Messari position ids when account resolver is unavailable", async () => {
    const chain = getChainConfig("optimism");
    const readAccounts: string[] = [];

    const positions = await getLiquidatablePositions({
      chain,
      pageSize: 2,
      graphClient: {
        request: async <T>(_query: string, variables: Record<string, number>): Promise<T> => {
          if (variables.skip === 0) {
            return {
              positions: [
                { id: "0x0000000000000000000000000000000000000001-0x38d693ce1df5aadf7bc62595a37d667ad57922e5-BORROWER-0" },
                { id: "0x0000000000000000000000000000000000000002-0x38d693ce1df5aadf7bc62595a37d667ad57922e5-BORROWER-0" },
              ],
            } as T;
          }

          return { positions: [] } as T;
        },
      },
      publicClient: {
        readContract: async ({ args }) => {
          readAccounts.push(args[0]);
          return [
            2_000n,
            1_000n,
            0n,
            4_000n,
            7_500n,
            800_000_000_000_000_000n,
          ] as const;
        },
      },
    });

    expect(readAccounts).toEqual([
      "0x0000000000000000000000000000000000000001",
      "0x0000000000000000000000000000000000000002",
    ]);
    expect(positions).toHaveLength(2);
  });

  it("scans one borrower page per protocol cycle and advances the cursor", async () => {
    const chain = getChainConfig("optimism");
    const skips: number[] = [];
    const readAccounts: string[] = [];
    const protocol = new ViemAaveV3Protocol(
      {
        readContract: async ({ args }) => {
          readAccounts.push(args[0]);
          return [2_000n, 1_000n, 0n, 4_000n, 7_500n, 800_000_000_000_000_000n] as const;
        },
      },
      chain,
      {
        request: async <T>(_query: string, variables: Record<string, number>): Promise<T> => {
          const skip = variables.skip ?? 0;
          skips.push(skip);
          const ids = skip === 0
            ? [
                "0x0000000000000000000000000000000000000001-0x38d693ce1df5aadf7bc62595a37d667ad57922e5-BORROWER-0",
                "0x0000000000000000000000000000000000000002-0x38d693ce1df5aadf7bc62595a37d667ad57922e5-BORROWER-0",
              ]
            : [
                "0x0000000000000000000000000000000000000003-0x38d693ce1df5aadf7bc62595a37d667ad57922e5-BORROWER-0",
              ];

          return { positions: ids.map((id) => ({ id })) } as T;
        },
      },
      undefined,
      2,
    );

    await protocol.getLiquidatablePositions();
    await protocol.getLiquidatablePositions();
    await protocol.getLiquidatablePositions();

    expect(skips).toEqual([0, 2, 0]);
    expect(readAccounts).toEqual([
      "0x0000000000000000000000000000000000000001",
      "0x0000000000000000000000000000000000000002",
      "0x0000000000000000000000000000000000000003",
      "0x0000000000000000000000000000000000000001",
      "0x0000000000000000000000000000000000000002",
    ]);
  });
});

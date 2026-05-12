import { describe, expect, it, vi } from "vitest";
import type { Address } from "viem";
import { getChainConfig } from "../../src/config/chains";
import { assertLiquidationReceiverReadiness, liquidationFlashReceiverAbi } from "../../src/production/liquidationReceiverReadiness";

describe("assertLiquidationReceiverReadiness", () => {
  const receiver = "0x0000000000000000000000000000000000000abc" as Address;
  const expectedRouter = "0x2626664c2603336E57B271c5C0b26F421741e481" as Address;
  const basePool = getChainConfig("base").aave.pool;

  it("throws when bytecode is empty", async () => {
    const client = {
      getBytecode: vi.fn().mockResolvedValue("0x"),
      readContract: vi.fn(),
    };
    await expect(
      assertLiquidationReceiverReadiness(client, {
        chain: "base",
        receiver,
        expectedSwapRouter: expectedRouter,
      }),
    ).rejects.toThrow(/no on-chain code/);
    expect(client.readContract).not.toHaveBeenCalled();
  });

  it("throws when version is not 1", async () => {
    const client = {
      getBytecode: vi.fn().mockResolvedValue("0x6000"),
      readContract: vi.fn().mockImplementation(async ({ functionName }: { functionName: string }) => {
        if (functionName === "receiverVersion") {
          return 2n;
        }
        throw new Error("unexpected");
      }),
    };
    await expect(
      assertLiquidationReceiverReadiness(client, {
        chain: "base",
        receiver,
        expectedSwapRouter: expectedRouter,
      }),
    ).rejects.toThrow(/version mismatch/);
  });

  it("throws when pool binding mismatches chain config", async () => {
    const wrongPool = "0x1111111111111111111111111111111111111111" as Address;
    const client = {
      getBytecode: vi.fn().mockResolvedValue("0x6000"),
      readContract: vi.fn().mockImplementation(async ({ functionName }: { functionName: string }) => {
        if (functionName === "receiverVersion") {
          return 1n;
        }
        if (functionName === "aavePool") {
          return wrongPool;
        }
        throw new Error("unexpected");
      }),
    };
    await expect(
      assertLiquidationReceiverReadiness(client, {
        chain: "base",
        receiver,
        expectedSwapRouter: expectedRouter,
      }),
    ).rejects.toThrow(/wrong Aave pool/);
    expect(client.readContract).toHaveBeenCalled();
  });

  it("throws when swap router mismatches", async () => {
    const client = {
      getBytecode: vi.fn().mockResolvedValue("0x6000"),
      readContract: vi.fn().mockImplementation(async ({ functionName }: { functionName: string }) => {
        if (functionName === "receiverVersion") {
          return 1n;
        }
        if (functionName === "aavePool") {
          return basePool;
        }
        if (functionName === "swapRouter") {
          return "0x2222222222222222222222222222222222222222" as Address;
        }
        throw new Error("unexpected");
      }),
    };
    await expect(
      assertLiquidationReceiverReadiness(client, {
        chain: "base",
        receiver,
        expectedSwapRouter: expectedRouter,
      }),
    ).rejects.toThrow(/swap router mismatch/);
  });

  it("resolves when all checks pass", async () => {
    const client = {
      getBytecode: vi.fn().mockResolvedValue("0x6000"),
      readContract: vi.fn().mockImplementation(async ({ functionName }: { functionName: string }) => {
        if (functionName === "receiverVersion") {
          return 1n;
        }
        if (functionName === "aavePool") {
          return basePool;
        }
        if (functionName === "swapRouter") {
          return expectedRouter;
        }
        throw new Error("unexpected");
      }),
    };
    await expect(
      assertLiquidationReceiverReadiness(client, {
        chain: "base",
        receiver,
        expectedSwapRouter: expectedRouter,
      }),
    ).resolves.toBeUndefined();
  });
});

describe("liquidationFlashReceiverAbi", () => {
  it("declares receiverVersion, aavePool, swapRouter", () => {
    const names = liquidationFlashReceiverAbi.map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining(["receiverVersion", "aavePool", "swapRouter"]));
  });
});

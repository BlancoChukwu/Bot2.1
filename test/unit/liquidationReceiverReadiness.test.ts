import { describe, expect, it, vi } from "vitest";
import type { Address } from "viem";
import { getChainConfig } from "../../src/config/chains";
import {
  assertLiquidationReceiverReadiness,
  DEFAULT_LIQUIDATION_RECEIVER_VERSION,
  fetchOnChainLiquidationReceiverVersion,
  liquidationFlashReceiverAbi,
  parseExpectedLiquidationReceiverVersion,
  verifyLiquidationReceiverReadiness,
} from "../../src/production/liquidationReceiverReadiness";

describe("parseExpectedLiquidationReceiverVersion", () => {
  it("defaults when env is unset", () => {
    expect(parseExpectedLiquidationReceiverVersion(undefined)).toBe(DEFAULT_LIQUIDATION_RECEIVER_VERSION);
  });

  it("parses explicit version from env", () => {
    expect(parseExpectedLiquidationReceiverVersion("1")).toBe(1n);
    expect(parseExpectedLiquidationReceiverVersion("2")).toBe(2n);
    expect(parseExpectedLiquidationReceiverVersion("3")).toBe(3n);
    expect(parseExpectedLiquidationReceiverVersion("4")).toBe(4n);
    expect(parseExpectedLiquidationReceiverVersion("5")).toBe(5n);
  });

  it("rejects invalid values", () => {
    expect(() => parseExpectedLiquidationReceiverVersion("abc")).toThrow(/non-negative integer/);
    expect(() => parseExpectedLiquidationReceiverVersion("0")).toThrow(/>= 1/);
  });
});

describe("fetchOnChainLiquidationReceiverVersion", () => {
  const receiver = "0x0000000000000000000000000000000000000abc" as Address;

  it("reads receiverVersion() first", async () => {
    const client = {
      readContract: vi.fn().mockResolvedValue(2n),
    };
    await expect(fetchOnChainLiquidationReceiverVersion(client, receiver)).resolves.toBe(2n);
    expect(client.readContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: "receiverVersion" }));
  });

  it("falls back to RECEIVER_VERSION when getter is absent", async () => {
    const client = {
      readContract: vi.fn()
        .mockRejectedValueOnce(new Error("no getter"))
        .mockResolvedValueOnce(1n),
    };
    await expect(fetchOnChainLiquidationReceiverVersion(client, receiver)).resolves.toBe(1n);
    expect(client.readContract).toHaveBeenCalledTimes(2);
  });
});

describe("verifyLiquidationReceiverReadiness", () => {
  const receiver = "0x0000000000000000000000000000000000000abc" as Address;
  const expectedRouter = "0x2626664c2603336E57B271c5C0b26F421741e481" as Address;
  const basePool = getChainConfig("base").aave.pool;

  it("throws when bytecode is empty", async () => {
    const client = {
      getBytecode: vi.fn().mockResolvedValue("0x"),
      readContract: vi.fn(),
    };
    await expect(
      verifyLiquidationReceiverReadiness(client, {
        chain: "base",
        receiver,
        expectedSwapRouter: expectedRouter,
      }),
    ).rejects.toThrow(/no on-chain code/);
    expect(client.readContract).not.toHaveBeenCalled();
  });

  it("throws when on-chain version does not match configured expectation", async () => {
    const client = {
      getBytecode: vi.fn().mockResolvedValue("0x6000"),
      readContract: vi.fn().mockImplementation(async ({ functionName }: { functionName: string }) => {
        if (functionName === "receiverVersion") {
          return 1n;
        }
        throw new Error("unexpected");
      }),
    };
    await expect(
      verifyLiquidationReceiverReadiness(client, {
        chain: "base",
        receiver,
        expectedSwapRouter: expectedRouter,
        expectedVersion: 2n,
      }),
    ).rejects.toThrow(/version mismatch at .* expected 2 .* on-chain 1/);
  });

  it("throws when pool binding mismatches chain config", async () => {
    const wrongPool = "0x1111111111111111111111111111111111111111" as Address;
    const client = {
      getBytecode: vi.fn().mockResolvedValue("0x6000"),
      readContract: vi.fn().mockImplementation(async ({ functionName }: { functionName: string }) => {
        if (functionName === "receiverVersion") {
          return DEFAULT_LIQUIDATION_RECEIVER_VERSION;
        }
        if (functionName === "aavePool") {
          return wrongPool;
        }
        throw new Error("unexpected");
      }),
    };
    await expect(
      verifyLiquidationReceiverReadiness(client, {
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
          return DEFAULT_LIQUIDATION_RECEIVER_VERSION;
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
      verifyLiquidationReceiverReadiness(client, {
        chain: "base",
        receiver,
        expectedSwapRouter: expectedRouter,
      }),
    ).rejects.toThrow(/swap router mismatch/);
  });

  it("returns on-chain values when all checks pass", async () => {
    const initiator = "0x3333333333333333333333333333333333333333" as Address;
    const client = {
      getBytecode: vi.fn().mockResolvedValue("0x6000"),
      readContract: vi.fn().mockImplementation(async ({ functionName }: { functionName: string }) => {
        if (functionName === "receiverVersion") {
          return DEFAULT_LIQUIDATION_RECEIVER_VERSION;
        }
        if (functionName === "aavePool") {
          return basePool;
        }
        if (functionName === "swapRouter") {
          return expectedRouter;
        }
        if (functionName === "authorizedInitiator") {
          return initiator;
        }
        if (functionName === "swapSlippageBps") {
          return 200n;
        }
        throw new Error("unexpected");
      }),
    };
    await expect(
      verifyLiquidationReceiverReadiness(client, {
        chain: "base",
        receiver,
        expectedSwapRouter: expectedRouter,
        expectedVersion: DEFAULT_LIQUIDATION_RECEIVER_VERSION,
        expectedAuthorizedInitiator: initiator,
        expectedSwapSlippageBps: 200n,
      }),
    ).resolves.toEqual({
      chain: "base",
      receiver,
      onChainVersion: DEFAULT_LIQUIDATION_RECEIVER_VERSION,
      expectedVersion: DEFAULT_LIQUIDATION_RECEIVER_VERSION,
      boundPool: basePool,
      boundRouter: expectedRouter,
      boundAuthorizedInitiator: initiator,
      boundSwapSlippageBps: 200n,
    });
  });

  it("throws when authorizedInitiator mismatches", async () => {
    const client = {
      getBytecode: vi.fn().mockResolvedValue("0x6000"),
      readContract: vi.fn().mockImplementation(async ({ functionName }: { functionName: string }) => {
        if (functionName === "receiverVersion") {
          return DEFAULT_LIQUIDATION_RECEIVER_VERSION;
        }
        if (functionName === "aavePool") {
          return basePool;
        }
        if (functionName === "swapRouter") {
          return expectedRouter;
        }
        if (functionName === "authorizedInitiator") {
          return "0x3333333333333333333333333333333333333333" as Address;
        }
        if (functionName === "swapSlippageBps") {
          return 200n;
        }
        throw new Error("unexpected");
      }),
    };
    await expect(
      verifyLiquidationReceiverReadiness(client, {
        chain: "base",
        receiver,
        expectedSwapRouter: expectedRouter,
        expectedAuthorizedInitiator: "0x4444444444444444444444444444444444444444" as Address,
      }),
    ).rejects.toThrow(/authorizedInitiator mismatch/);
  });

  it("throws when swapSlippageBps mismatches", async () => {
    const client = {
      getBytecode: vi.fn().mockResolvedValue("0x6000"),
      readContract: vi.fn().mockImplementation(async ({ functionName }: { functionName: string }) => {
        if (functionName === "receiverVersion") {
          return DEFAULT_LIQUIDATION_RECEIVER_VERSION;
        }
        if (functionName === "aavePool") {
          return basePool;
        }
        if (functionName === "swapRouter") {
          return expectedRouter;
        }
        if (functionName === "authorizedInitiator") {
          return "0x3333333333333333333333333333333333333333" as Address;
        }
        if (functionName === "swapSlippageBps") {
          return 200n;
        }
        throw new Error("unexpected");
      }),
    };
    await expect(
      verifyLiquidationReceiverReadiness(client, {
        chain: "base",
        receiver,
        expectedSwapRouter: expectedRouter,
        expectedSwapSlippageBps: 50n,
      }),
    ).rejects.toThrow(/swapSlippageBps mismatch/);
  });
});

describe("assertLiquidationReceiverReadiness", () => {
  const receiver = "0x0000000000000000000000000000000000000abc" as Address;
  const expectedRouter = "0x2626664c2603336E57B271c5C0b26F421741e481" as Address;
  const basePool = getChainConfig("base").aave.pool;

  it("delegates to verify and returns the readiness result", async () => {
    const client = {
      getBytecode: vi.fn().mockResolvedValue("0x6000"),
      readContract: vi.fn().mockImplementation(async ({ functionName }: { functionName: string }) => {
        if (functionName === "receiverVersion") {
          return DEFAULT_LIQUIDATION_RECEIVER_VERSION;
        }
        if (functionName === "aavePool") {
          return basePool;
        }
        if (functionName === "swapRouter") {
          return expectedRouter;
        }
        if (functionName === "authorizedInitiator") {
          return "0x3333333333333333333333333333333333333333" as Address;
        }
        if (functionName === "swapSlippageBps") {
          return 200n;
        }
        throw new Error("unexpected");
      }),
    };
    const result = await assertLiquidationReceiverReadiness(client, {
      chain: "base",
      receiver,
      expectedSwapRouter: expectedRouter,
    });
    expect(result.onChainVersion).toBe(DEFAULT_LIQUIDATION_RECEIVER_VERSION);
    expect(result.boundSwapSlippageBps).toBe(200n);
  });
});

describe("liquidationFlashReceiverAbi", () => {
  it("declares receiverVersion, owner, RECEIVER_VERSION, aavePool, swapRouter, authorizedInitiator, swapSlippageBps, oracleMinDebtOut, decodeRouteParams", () => {
    const names = liquidationFlashReceiverAbi.map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining([
      "receiverVersion",
      "owner",
      "RECEIVER_VERSION",
      "aavePool",
      "swapRouter",
      "authorizedInitiator",
      "swapSlippageBps",
      "oracleMinDebtOut",
      "decodeRouteParams",
    ]));
  });
});

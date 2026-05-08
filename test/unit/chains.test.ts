import { describe, expect, it } from "vitest";
import { getChainConfig, parseSupportedChain } from "../../src/config/chains";

describe("chain configuration", () => {
  it("loads Optimism as the active Aave V3 chain", () => {
    const chain = getChainConfig("optimism");

    expect(chain.name).toBe("optimism");
    expect(chain.chainId).toBe(10);
    expect(chain.aave.pool).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(chain.aave.uiPoolDataProvider).toMatch(/^0x[a-fA-F0-9]{40}$/);
  });

  it("keeps Arbitrum available without making it the default", () => {
    expect(getChainConfig("arbitrum").chainId).toBe(42161);
    expect(parseSupportedChain(undefined)).toBe("optimism");
  });

  it("supports Base for arbitration rollout", () => {
    expect(getChainConfig("base").chainId).toBe(8453);
    expect(parseSupportedChain("base")).toBe("base");
  });

  it("rejects unsupported chains before startup", () => {
    expect(() => parseSupportedChain("polygon")).toThrow(/Unsupported chain/);
  });
});

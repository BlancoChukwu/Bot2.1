import { describe, expect, it } from "vitest";
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
import { getChainConfig } from "../../src/config/chains";
import { chainlinkLogsFilter } from "../../src/monitors/flashblocksWsClient";
import { uiPoolDataProviderAbi } from "../../src/protocols/uiPoolDataProvider";

describe("uiPoolDataProviderAbi", () => {
  it("decodes Base getUserReservesData with the v3-origin struct layout", async () => {
    const chain = getChainConfig("base");
    const client = createPublicClient({ chain: base, transport: http("https://mainnet.base.org") });
    const [reserves, emode] = await client.readContract({
      address: chain.aave.uiPoolDataProvider,
      abi: uiPoolDataProviderAbi,
      functionName: "getUserReservesData",
      args: [chain.aave.poolAddressesProvider, "0x974D4CeAd41a6509da07889B8a9a23c37850b778"],
    });

    expect(reserves.length).toBeGreaterThan(0);
    expect(typeof emode).toBe("number");
    expect(reserves[0]?.underlyingAsset).toMatch(/^0x[a-fA-F0-9]{40}$/);
  });
});

describe("chainlinkLogsFilter", () => {
  it("uses address-only filters for WS provider compatibility", () => {
    const filter = chainlinkLogsFilter("0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70");
    expect(filter).toEqual({
      address: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70",
    });
    expect(filter).not.toHaveProperty("topics");
  });
});

import { describe, expect, it } from "vitest";
import {
  canonicalBaseAaveOracleAddress,
  canonicalBaseCbBtcUsdFeed,
  canonicalBaseEthUsdFeed,
  canonicalBaseUsdcUsdFeed,
} from "../../src/utils/priceOracleCache";

describe("Base oracle constants", () => {
  it("uses verified Base Chainlink ETH/USD and Aave oracle addresses", () => {
    expect(canonicalBaseEthUsdFeed.toLowerCase()).toBe("0x71041dddad3595f9ced3dccfbe3d1f4b0a16bb70");
    expect(canonicalBaseUsdcUsdFeed.toLowerCase()).toBe("0x7e860098f58bbfc8648a4311b374b1d669a2bc6b");
    expect(canonicalBaseCbBtcUsdFeed.toLowerCase()).toBe("0x07da0e54543a844a80abe69c8a12f22b3aa59f9d");
    expect(canonicalBaseAaveOracleAddress.toLowerCase()).toBe(
      "0x2cc0fc26ed4563a5ce5e8bdcfe1a2878676ae156",
    );
  });
});

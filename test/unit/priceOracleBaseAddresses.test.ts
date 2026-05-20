import { describe, expect, it } from "vitest";
import {
  canonicalBaseAaveOracleAddress,
  canonicalBaseEthUsdFeed,
} from "../../src/utils/priceOracleCache";

describe("Base oracle constants", () => {
  it("uses verified Base Chainlink ETH/USD and Aave oracle addresses", () => {
    expect(canonicalBaseEthUsdFeed.toLowerCase()).toBe("0x71041dddad3595f9ced3dccfbe3d1f4b0a16bb70");
    expect(canonicalBaseAaveOracleAddress.toLowerCase()).toBe(
      "0x2cc0fc26ed4563a5ce5e8bdcfe1a2878676ae156",
    );
  });
});

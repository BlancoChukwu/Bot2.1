import { describe, expect, it } from "vitest";
import { mergeBorrowerAddresses } from "../../src/protocols/borrowerDiscovery";
import type { BorrowerDiscoveryAdapter } from "../../src/protocols/borrowerDiscovery";

describe("borrowerDiscovery", () => {
  it("dedupes addresses across adapters", async () => {
    const shared = "0x00000000000000000000000000000000000000aa";
    const moonwellOnly = "0x00000000000000000000000000000000000000bb";
    const adapters: readonly BorrowerDiscoveryAdapter[] = [
      {
        protocol: "moonwell",
        listBorrowerAddresses: async () => [shared, moonwellOnly],
      },
      {
        protocol: "seamless",
        listBorrowerAddresses: async () => [shared.toUpperCase() as `0x${string}`],
      },
    ];

    const merged = await mergeBorrowerAddresses(adapters, "base");
    expect(merged.addresses).toHaveLength(2);
    expect(merged.counts).toEqual([
      { protocol: "moonwell", count: 2 },
      { protocol: "seamless", count: 0 },
    ]);
  });
});

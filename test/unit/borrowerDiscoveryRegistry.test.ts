import { describe, expect, it } from "vitest";
import {
  createBorrowerDiscoveryAdapters,
  parseBorrowerDiscoveryFromEnv,
} from "../../src/protocols/borrowerDiscoveryRegistry";

describe("borrowerDiscoveryRegistry", () => {
  it("parses enabled adapters from env", () => {
    const input = parseBorrowerDiscoveryFromEnv({
      MOONWELL_ENABLED: "true",
      MOONWELL_SUBGRAPH_URL: "https://moonwell.example/subgraphs/id/abc",
      SEAMLESS_ENABLED: "1",
      SEAMLESS_SUBGRAPH_URL: "https://seamless.example/subgraphs/id/def",
    });
    const adapters = createBorrowerDiscoveryAdapters(input);
    expect(adapters.map((adapter) => adapter.protocol)).toEqual(["moonwell", "seamless"]);
  });

  it("returns no adapters when disabled", () => {
    const adapters = createBorrowerDiscoveryAdapters(parseBorrowerDiscoveryFromEnv({}));
    expect(adapters).toHaveLength(0);
  });
});

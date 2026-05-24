import { describe, expect, it } from "vitest";
import { computeSubgraphLag } from "../../src/utils/subgraphMeta";

describe("subgraphMeta", () => {
  it("computes positive lag when chain is ahead of indexer", () => {
    expect(computeSubgraphLag(120n, 100n)).toBe(20n);
  });

  it("returns zero when indexer is not behind", () => {
    expect(computeSubgraphLag(100n, 120n)).toBe(0n);
  });
});

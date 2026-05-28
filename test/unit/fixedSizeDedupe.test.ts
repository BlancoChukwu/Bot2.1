import { describe, expect, it } from "vitest";
import { FixedSizeDedupe } from "../../src/utils/fixedSizeDedupe";

describe("FixedSizeDedupe", () => {
  it("evicts oldest entry at capacity", () => {
    const dedupe = new FixedSizeDedupe(2);
    expect(dedupe.add("a")).toBe(true);
    expect(dedupe.add("b")).toBe(true);
    expect(dedupe.add("a")).toBe(false);
    expect(dedupe.add("c")).toBe(true);
    expect(dedupe.has("a")).toBe(false);
    expect(dedupe.has("b")).toBe(true);
    expect(dedupe.has("c")).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { linearRegressionHf, projectHfBlocksAhead } from "../../src/utils/hfLinearRegression";

describe("hfLinearRegression", () => {
  it("detects declining HF with negative slope", () => {
    const base = Date.now();
    const samples = Array.from({ length: 5 }, (_, index) => ({
      atMs: base + index * 2_000,
      healthFactor: 1.04 - index * 0.005,
    }));
    const regression = linearRegressionHf(samples);
    expect(regression).toBeDefined();
    expect(regression!.slopePerMs).toBeLessThan(0);
    const projected = projectHfBlocksAhead(regression!, samples[samples.length - 1]!, 10);
    expect(projected).toBeLessThan(1.04);
  });
});

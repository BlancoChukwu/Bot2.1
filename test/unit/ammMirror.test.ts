import { describe, expect, it } from "vitest";
import { AmmMirror } from "../../src/mirror/ammMirror";

describe("AmmMirror", () => {
  it("quotes from mirrored sqrt price", () => {
    const mirror = new AmmMirror();
    mirror.upsert({
      pool: "0x0000000000000000000000000000000000000001",
      sqrtPriceX96: 2n ** 96n,
      liquidity: 1_000_000n,
      tick: 0,
      updatedAtMs: Date.now(),
    });
    const out = mirror.quoteExactInputSingle(
      "0x0000000000000000000000000000000000000001",
      1_000_000n,
      true,
    );
    expect(out).toBeGreaterThan(0n);
  });
});

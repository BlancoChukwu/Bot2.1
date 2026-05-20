import { describe, expect, it } from "vitest";
import { BorrowerCooldownRegistry } from "../../src/utils/borrowerCooldown";

const account = "0x00000000000000000000000000000000000000aa" as const;

describe("BorrowerCooldownRegistry", () => {
  it("blocks a borrower until ttl expires", () => {
    let now = 1_000;
    const registry = new BorrowerCooldownRegistry({
      cooldownMs: 600_000,
      nowMs: () => now,
    });
    registry.blockBorrower("base", account, "final_simulation_failed");
    expect(registry.isBorrowerBlocked("base", account)).toBe(true);
    now += 599_999;
    expect(registry.isBorrowerBlocked("base", account)).toBe(true);
    now += 2;
    expect(registry.isBorrowerBlocked("base", account)).toBe(false);
  });
});

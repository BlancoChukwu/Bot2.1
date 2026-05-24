import { describe, expect, it } from "vitest";
import { shouldApplyBorrowerCooldown } from "../../src/utils/borrowerCooldownPolicy";

describe("borrowerCooldownPolicy", () => {
  it("cooldowns only after real execution failures", () => {
    expect(shouldApplyBorrowerCooldown("final_simulation_failed")).toBe(true);
    expect(shouldApplyBorrowerCooldown("receipt_reverted")).toBe(true);
    expect(shouldApplyBorrowerCooldown("route_rejected")).toBe(false);
    expect(shouldApplyBorrowerCooldown("dust_filtered")).toBe(false);
  });
});

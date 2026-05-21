import { describe, expect, it } from "vitest";
import { DustLogCooldown } from "../../src/utils/dustLogCooldown";

describe("DustLogCooldown", () => {
  it("allows first log then blocks within interval", () => {
    const cooldown = new DustLogCooldown(60_000);
    expect(cooldown.shouldLog("0xabc", 0)).toBe(true);
    expect(cooldown.shouldLog("0xabc", 1_000)).toBe(false);
    expect(cooldown.shouldLog("0xabc", 61_000)).toBe(true);
  });
});

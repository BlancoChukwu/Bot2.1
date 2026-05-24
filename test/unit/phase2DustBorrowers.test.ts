import { describe, expect, it } from "vitest";
import {
  phase2DustBorrowerAccounts,
  phase2DustDebtAsset,
} from "../../src/constants/phase2DustBorrowers";

describe("phase2DustBorrowers", () => {
  it("lists four known burst accounts with expected prefixes", () => {
    expect(phase2DustBorrowerAccounts).toHaveLength(4);
    const prefixes = ["0x11c15e88", "0x0eb4d9dc", "0x0abb51d8", "0x138bf0b3"];
    for (let i = 0; i < prefixes.length; i += 1) {
      expect(phase2DustBorrowerAccounts[i]!.toLowerCase()).toMatch(
        new RegExp(`^${prefixes[i]!.toLowerCase()}[a-f0-9]{32}$`),
      );
    }
  });

  it("uses Base USDC as debt asset", () => {
    expect(phase2DustDebtAsset.toLowerCase()).toBe(
      "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    );
  });
});

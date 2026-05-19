import { describe, expect, it } from "vitest";
import { isAddress, isHex } from "viem";
import { createBurnerWallet } from "../../src/wallet/createBurnerWallet";

describe("createBurnerWallet", () => {
  it("returns a valid 32-byte private key and derived address", () => {
    const wallet = createBurnerWallet();

    expect(isHex(wallet.privateKey)).toBe(true);
    expect(wallet.privateKey.length).toBe(66);
    expect(isAddress(wallet.address)).toBe(true);
  });

  it("generates distinct wallets on each call", () => {
    const a = createBurnerWallet();
    const b = createBurnerWallet();

    expect(a.privateKey).not.toBe(b.privateKey);
    expect(a.address).not.toBe(b.address);
  });
});

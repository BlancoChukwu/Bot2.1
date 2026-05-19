import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";

export interface BurnerWallet {
  readonly privateKey: Hex;
  readonly address: Address;
}

/** Cryptographically random EOA for bot hot-wallet / burner use (fund with minimal native gas). */
export function createBurnerWallet(): BurnerWallet {
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  return { privateKey, address: account.address };
}

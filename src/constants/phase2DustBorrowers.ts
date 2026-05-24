import type { Address } from "viem";

/** Phase 2 burst dust borrowers from live session 2026-05-20 (Base USDC debt). */
export const phase2DustBorrowerAccounts: readonly Address[] = [
  "0x11c15e88d35f4cfe558c5ce57a9b4f16235e54f6",
  "0x0eb4d9dc612f691797883414a43cc4d7b5b372b7",
  "0x0abb51d8f11bbd3a9d6e25c0623bbece70b27e21",
  "0x138bf0b3f4e5873fc073a10acc3a8c14dc5e4e97",
] as const;

export const phase2DustDebtAsset = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;

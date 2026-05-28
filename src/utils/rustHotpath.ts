import type { RouteInput } from "../indexing/rustHotpathTypes";

export interface RustHotpathModule {
  quickMarginBps(input: RouteInput): number;
}

let cachedModule: RustHotpathModule | undefined;
let loadAttempted = false;

export function isRustHotpathEnabled(): boolean {
  return process.env.RUST_HOTPATH_ENABLED === "true";
}

export function loadRustHotpath(): RustHotpathModule | undefined {
  if (!isRustHotpathEnabled()) {
    return undefined;
  }
  if (loadAttempted) {
    return cachedModule;
  }
  loadAttempted = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const native = require("../../rust-hotpath/index.node") as RustHotpathModule;
    cachedModule = native;
    return native;
  } catch {
    cachedModule = undefined;
    return undefined;
  }
}

/** Pure-JS fallback when native module is disabled or unavailable. */
export function quickMarginBpsJs(input: RouteInput): number {
  const debt = BigInt(input.debtRaw);
  const revenue = BigInt(input.revenueRaw);
  if (debt <= 0n) {
    return 0;
  }
  return Number(((revenue - debt) * 10_000n) / debt);
}

export function quickMarginBps(input: RouteInput): number {
  const native = loadRustHotpath();
  if (native !== undefined) {
    return native.quickMarginBps(input);
  }
  return quickMarginBpsJs(input);
}

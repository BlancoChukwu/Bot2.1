import { describe, expect, it, vi } from "vitest";
import { warnIfUnstableWssProvider } from "../../src/utils/wssProviderCheck";

describe("wssProviderCheck", () => {
  it("warns when primary host matches unstable provider pattern", () => {
    const warn = vi.fn();
    warnIfUnstableWssProvider({
      primary: "wss://base-mainnet.dwellir.com/ws",
      logger: { info: vi.fn(), warn, error: vi.fn() },
    });
    expect(warn).toHaveBeenCalledWith(
      "wss_provider_unstable_host_detected",
      expect.objectContaining({ tier: "primary", host: "base-mainnet.dwellir.com" }),
    );
  });
});

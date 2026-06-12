import { describe, expect, it } from "vitest";
import { dedupeRpcUrls, isRetryableRpcError } from "../../src/monitors/bootstrapRpcClients";

describe("bootstrapRpcClients", () => {
  it("dedupes rpc urls preserving order", () => {
    expect(dedupeRpcUrls([
      "https://a.example",
      "https://b.example",
      "https://a.example",
      "",
      "  ",
    ])).toEqual([
      "https://a.example",
      "https://b.example",
    ]);
  });

  it("detects retryable rpc errors", () => {
    expect(isRetryableRpcError(new Error("Monthly capacity limit exceeded"))).toBe(true);
    expect(isRetryableRpcError(new Error("HTTP 429 Too Many Requests"))).toBe(true);
    expect(isRetryableRpcError(new Error("invalid opcode"))).toBe(false);
  });
});

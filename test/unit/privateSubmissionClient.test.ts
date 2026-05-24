import { describe, expect, it, vi } from "vitest";
import { createLogger } from "../../src/bot";
import { PrivateSubmissionClient } from "../../src/executors/PrivateSubmissionClient";

const request = {
  chain: "base" as const,
  account: "0x0000000000000000000000000000000000000001",
  opportunityId: "base:1",
  gasProfileKey: "aave",
  routeInput: {} as never,
  buildTransaction: () => ({ to: "0x0000000000000000000000000000000000000002" as const, data: "0x1234" as const, provider: "aaveV3" as const }),
} as const;

describe("PrivateSubmissionClient", () => {
  it("submits through provider private endpoint in auto mode", async () => {
    const providerSend = vi.fn(async () => "0xabc" as const);
    const client = new PrivateSubmissionClient({
      mode: "auto",
      logger: createLogger("silent"),
      providerPrivateWalletClient: { sendTransaction: providerSend },
    });

    const hash = await client.send({
      route: "private_bundle",
      request: request as never,
      transaction: { to: "0x0000000000000000000000000000000000000002" as const, data: "0x1234" as const, provider: "aaveV3" },
      overrides: { gas: 1n, gasPrice: 1n, nonce: 1 },
      risk: { riskBps: 8_000, observedCompetitors: 1 },
    });

    expect(hash).toBe("0xabc");
    expect(providerSend).toHaveBeenCalledTimes(1);
  });

  it("falls back to sequencer direct when provider private fails", async () => {
    const client = new PrivateSubmissionClient({
      mode: "auto",
      logger: createLogger("silent"),
      providerPrivateWalletClient: { sendTransaction: async () => { throw new Error("provider down"); } },
      sequencerWalletClient: { sendTransaction: async () => "0xdef" as const },
    });

    const hash = await client.send({
      route: "private_bundle",
      request: request as never,
      transaction: { to: "0x0000000000000000000000000000000000000002" as const, data: "0x1234" as const, provider: "aaveV3" },
      overrides: { gas: 1n, gasPrice: 1n, nonce: 1 },
      risk: { riskBps: 8_000, observedCompetitors: 1 },
    });

    expect(hash).toBe("0xdef");
  });
});

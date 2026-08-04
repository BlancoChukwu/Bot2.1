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

const envelope = {
  route: "private_bundle" as const,
  request: request as never,
  transaction: {
    to: "0x0000000000000000000000000000000000000002" as const,
    data: "0x1234" as const,
    provider: "aaveV3" as const,
  },
  overrides: { gas: 1n, gasPrice: 1n, nonce: 1 },
  risk: { riskBps: 8_000, observedCompetitors: 1 },
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("PrivateSubmissionClient", () => {
  it("submits through provider private endpoint in auto mode", async () => {
    const providerSend = vi.fn(async () => "0xabc" as const);
    const client = new PrivateSubmissionClient({
      mode: "auto",
      logger: createLogger("silent"),
      providerPrivateWalletClient: { sendTransaction: providerSend },
    });

    const hash = await client.send(envelope);

    expect(hash).toBe("0xabc");
    expect(providerSend).toHaveBeenCalledTimes(1);
  });

  it("returns sequencer when provider private fails in auto race", async () => {
    const client = new PrivateSubmissionClient({
      mode: "auto",
      logger: createLogger("silent"),
      providerPrivateWalletClient: {
        sendTransaction: async () => {
          throw new Error("provider down");
        },
      },
      sequencerWalletClient: { sendTransaction: async () => "0xdef" as const },
    });

    const hash = await client.send(envelope);
    expect(hash).toBe("0xdef");
  });

  it("provider_private-only mode never touches sequencer", async () => {
    const providerSend = vi.fn(async () => "0xabc" as const);
    const sequencerSend = vi.fn(async () => "0xdef" as const);
    const client = new PrivateSubmissionClient({
      mode: "provider_private",
      logger: createLogger("silent"),
      providerPrivateWalletClient: { sendTransaction: providerSend },
      sequencerWalletClient: { sendTransaction: sequencerSend },
    });

    const hash = await client.send(envelope);
    expect(hash).toBe("0xabc");
    expect(providerSend).toHaveBeenCalledTimes(1);
    expect(sequencerSend).not.toHaveBeenCalled();
  });

  it("sequencer_direct-only mode never touches provider private", async () => {
    const providerSend = vi.fn(async () => "0xabc" as const);
    const sequencerSend = vi.fn(async () => "0xdef" as const);
    const client = new PrivateSubmissionClient({
      mode: "sequencer_direct",
      logger: createLogger("silent"),
      providerPrivateWalletClient: { sendTransaction: providerSend },
      sequencerWalletClient: { sendTransaction: sequencerSend },
    });

    const hash = await client.send(envelope);
    expect(hash).toBe("0xdef");
    expect(sequencerSend).toHaveBeenCalledTimes(1);
    expect(providerSend).not.toHaveBeenCalled();
  });

  it("races both auto legs concurrently; faster leg wins regardless of order", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const track = async <T>(work: () => Promise<T>): Promise<T> => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        return await work();
      } finally {
        inFlight -= 1;
      }
    };

    const providerSend = vi.fn(async () =>
      track(async () => {
        await delay(80);
        return "0xprovider" as const;
      }),
    );
    const sequencerSend = vi.fn(async () =>
      track(async () => {
        await delay(15);
        return "0xsequencer" as const;
      }),
    );

    const client = new PrivateSubmissionClient({
      mode: "auto",
      logger: createLogger("silent"),
      providerPrivateWalletClient: { sendTransaction: providerSend },
      sequencerWalletClient: { sendTransaction: sequencerSend },
    });

    const wallStarted = Date.now();
    const hash = await client.send(envelope);
    const elapsedMs = Date.now() - wallStarted;

    expect(hash).toBe("0xsequencer");
    expect(providerSend).toHaveBeenCalledTimes(1);
    expect(sequencerSend).toHaveBeenCalledTimes(1);
    // Both requests were outstanding at the same time — not merely both called.
    expect(maxInFlight).toBe(2);
    expect(elapsedMs).toBeLessThan(70);

    // Reverse timing: provider faster → provider wins.
    inFlight = 0;
    maxInFlight = 0;
    const providerFast = vi.fn(async () =>
      track(async () => {
        await delay(15);
        return "0xprovider_fast" as const;
      }),
    );
    const sequencerSlow = vi.fn(async () =>
      track(async () => {
        await delay(80);
        return "0xsequencer_slow" as const;
      }),
    );
    const reverse = new PrivateSubmissionClient({
      mode: "auto",
      logger: createLogger("silent"),
      providerPrivateWalletClient: { sendTransaction: providerFast },
      sequencerWalletClient: { sendTransaction: sequencerSlow },
    });
    const reverseHash = await reverse.send(envelope);
    expect(reverseHash).toBe("0xprovider_fast");
    expect(maxInFlight).toBe(2);
  });

  it("hung provider_private does not block sequencer_direct from returning promptly", async () => {
    let resolveProvider: ((hash: `0x${string}`) => void) | undefined;
    const providerHang = new Promise<`0x${string}`>((resolve) => {
      resolveProvider = resolve;
    });
    const providerSend = vi.fn(async () => providerHang);
    const sequencerSend = vi.fn(async () => {
      await delay(20);
      return "0xsequencer_prompt" as const;
    });

    const client = new PrivateSubmissionClient({
      mode: "auto",
      logger: createLogger("silent"),
      providerPrivateWalletClient: { sendTransaction: providerSend },
      sequencerWalletClient: { sendTransaction: sequencerSend },
    });

    const wallStarted = Date.now();
    const hash = await client.send(envelope);
    const elapsedMs = Date.now() - wallStarted;

    expect(hash).toBe("0xsequencer_prompt");
    expect(elapsedMs).toBeLessThan(100);
    expect(providerSend).toHaveBeenCalledTimes(1);
    expect(sequencerSend).toHaveBeenCalledTimes(1);

    // Release hung leg so the test process can exit cleanly.
    resolveProvider?.("0xprovider_late");
    await providerHang;
  });

  it("aggregates both failure reasons when both auto legs reject", async () => {
    const client = new PrivateSubmissionClient({
      mode: "auto",
      logger: createLogger("silent"),
      providerPrivateWalletClient: {
        sendTransaction: async () => {
          throw new Error("provider boom");
        },
      },
      sequencerWalletClient: {
        sendTransaction: async () => {
          throw new Error("sequencer boom");
        },
      },
    });

    await expect(client.send(envelope)).rejects.toThrow(
      /private submission failed across configured targets:.*provider_private: provider boom.*sequencer_direct: sequencer boom/,
    );
  });
});

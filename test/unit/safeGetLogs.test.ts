import { describe, expect, it, vi } from "vitest";
import type { PublicClient } from "viem";
import { isHeadBlockRaceError, safeGetLogs } from "../../src/utils/safeGetLogs";

type LogsClient = Pick<PublicClient, "getLogs" | "getBlockNumber">;

function headRaceError(): Error & { code: number; details: string } {
  return Object.assign(new Error("Invalid params"), {
    code: -32602,
    details: "block range extends beyond current head block",
  });
}

describe("isHeadBlockRaceError", () => {
  it("detects NodeReal head-block race messages", () => {
    expect(isHeadBlockRaceError(headRaceError())).toBe(true);
  });

  it("ignores unrelated RPC failures", () => {
    expect(isHeadBlockRaceError(new Error("rate limit"))).toBe(false);
  });
});

describe("safeGetLogs", () => {
  it("returns logs on the first successful call", async () => {
    const getLogs = vi.fn(async () => [{ logIndex: 0 }]);
    const client = { getLogs, getBlockNumber: async () => 100n } as unknown as LogsClient;

    const logs = await safeGetLogs(client, {
      address: "0x0000000000000000000000000000000000000001",
      fromBlock: 99n,
      toBlock: 99n,
    });

    expect(logs).toEqual([{ logIndex: 0 }]);
    expect(getLogs).toHaveBeenCalledTimes(1);
  });

  it("retries after head-block race and clamps to current head", async () => {
    let head = 98n;
    const getLogs = vi
      .fn()
      .mockRejectedValueOnce(headRaceError())
      .mockResolvedValueOnce([]);
    const getBlockNumber = vi.fn(async () => head);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await safeGetLogs(
      { getLogs, getBlockNumber } as unknown as LogsClient,
      {
        address: "0x0000000000000000000000000000000000000001",
        fromBlock: 100n,
        toBlock: 100n,
      },
      { logger, tag: "flashblocks" },
    );

    expect(getLogs).toHaveBeenCalledTimes(2);
    expect(getBlockNumber).toHaveBeenCalledTimes(1);
    expect(getLogs.mock.calls[1]?.[0]).toEqual({
      address: "0x0000000000000000000000000000000000000001",
      fromBlock: 98n,
      toBlock: 98n,
    });
    expect(logger.warn).toHaveBeenCalledWith(
      "eth_getlogs_head_race_retry",
      expect.objectContaining({ tag: "flashblocks", head: "98" }),
    );
  });

  it("rethrows non-recoverable errors immediately", async () => {
    const getLogs = vi.fn(async () => {
      throw new Error("internal error");
    });
    await expect(
      safeGetLogs(
        { getLogs, getBlockNumber: async () => 1n } as unknown as LogsClient,
        { address: "0x0000000000000000000000000000000000000001", fromBlock: 1n, toBlock: 1n },
      ),
    ).rejects.toThrow("internal error");
    expect(getLogs).toHaveBeenCalledTimes(1);
  });

  it("throws after exhausting retries", async () => {
    const getLogs = vi.fn(async () => {
      throw headRaceError();
    });
    await expect(
      safeGetLogs(
        { getLogs, getBlockNumber: async () => 50n } as unknown as LogsClient,
        {
          address: "0x0000000000000000000000000000000000000001",
          fromBlock: 55n,
          toBlock: 55n,
        },
        { maxRetries: 2 },
      ),
    ).rejects.toMatchObject({
      code: -32602,
      details: "block range extends beyond current head block",
    });
    expect(getLogs).toHaveBeenCalledTimes(2);
  });
});

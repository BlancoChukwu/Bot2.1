import { describe, expect, it } from "vitest";
import { TieredConfirmQueue } from "../../src/monitors/tieredConfirmQueue";

describe("tieredConfirmQueue", () => {
  it("does not call RPC when urgent queue is empty", async () => {
    const client = {
      multicall: async () => {
        throw new Error("should not multicall");
      },
    };
    const queue = new TieredConfirmQueue({
      client: client as never,
      poolAddress: "0xA238Dd80C259a72e81d7e4664a980a968Ba86B47",
      enableWatchTier: false,
    });
    await expect(queue.flushUrgent()).resolves.toEqual([]);
  });
});

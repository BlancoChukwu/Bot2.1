import { describe, expect, it } from "vitest";
import { LocalNonceManager } from "../../src/executors/nonceManager";

const account = "0x0000000000000000000000000000000000000001";

describe("LocalNonceManager", () => {
  it("reserves unique pending nonces across concurrent requests", async () => {
    let reads = 0;
    const manager = new LocalNonceManager();

    const [first, second, third] = await Promise.all([
      manager.reserve("optimism", account, async () => {
        reads += 1;
        return 7;
      }),
      manager.reserve("optimism", account, async () => {
        reads += 1;
        return 7;
      }),
      manager.reserve("optimism", account, async () => {
        reads += 1;
        return 7;
      }),
    ]);

    expect([first.nonce, second.nonce, third.nonce]).toEqual([7, 8, 9]);
    expect(reads).toBe(1);
  });

  it("releases an unsubmitted reservation so the nonce can be reused", async () => {
    const manager = new LocalNonceManager();
    const reservation = await manager.reserve("optimism", account, async () => 11);

    manager.release(reservation);
    const reused = await manager.reserve("optimism", account, async () => 11);

    expect(reused.nonce).toBe(11);
  });

  it("ignores duplicate releases so a nonce cannot be handed out twice", async () => {
    const manager = new LocalNonceManager();
    const reservation = await manager.reserve("optimism", account, async () => 21);

    manager.release(reservation);
    manager.release(reservation);
    const first = await manager.reserve("optimism", account, async () => 21);
    const second = await manager.reserve("optimism", account, async () => 21);

    expect([first.nonce, second.nonce]).toEqual([21, 22]);
  });

  it("retries pending nonce initialization after a transient read failure", async () => {
    const manager = new LocalNonceManager();
    let reads = 0;
    await expect(
      manager.reserve("optimism", account, async () => {
        reads += 1;
        throw new Error("rpc timeout");
      }),
    ).rejects.toThrow("rpc timeout");

    const reservation = await manager.reserve("optimism", account, async () => {
      reads += 1;
      return 31;
    });

    expect(reservation.nonce).toBe(31);
    expect(reads).toBe(2);
  });
});

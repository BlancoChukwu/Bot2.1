import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireSingleInstanceLock } from "../../src/utils/singleInstanceLock";

describe("acquireSingleInstanceLock stale heal", () => {
  it("removes stale lock for dead pid and acquires", () => {
    const dir = join(tmpdir(), `bot-lock-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const lockPath = join(dir, "bot.lock");
    writeFileSync(lockPath, "99999999\n", "utf8");
    const removed: number[] = [];
    const lock = acquireSingleInstanceLock({
      lockPath,
      pid: process.pid,
      onStaleLockRemoved: (pid) => removed.push(pid),
    });
    expect(lock).not.toBeNull();
    expect(removed).toEqual([99_999_999]);
    expect(existsSync(lockPath)).toBe(true);
    lock?.release();
    rmSync(dir, { recursive: true, force: true });
  });
});

import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireSingleInstanceLock } from "../../src/utils/singleInstanceLock";

describe("acquireSingleInstanceLock", () => {
  it("allows re-entrant acquire for the same pid", () => {
    const dir = mkdtempSync(join(tmpdir(), "bot-lock-"));
    const lockPath = join(dir, "bot.lock");
    try {
      const first = acquireSingleInstanceLock({ lockPath });
      const second = acquireSingleInstanceLock({ lockPath });
      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      first?.release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

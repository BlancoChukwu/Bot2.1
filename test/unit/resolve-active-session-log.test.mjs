/**
 * Unit coverage for resolve-active-session-log preference order.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const script = join(process.cwd(), "scripts", "resolve-active-session-log.mjs");

describe("resolve-active-session-log preference", () => {
  it("prefers latest-session even when a larger soak log exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "resolve-session-"));
    try {
      mkdirSync(join(dir, "logs"));
      const tinyProd = join(dir, "logs", "event-purity-production-fresh.log");
      const hugeSoak = join(dir, "logs", "event-purity-soak-old.log");
      writeFileSync(tinyProd, "x".repeat(100), "utf8");
      writeFileSync(hugeSoak, "y".repeat(10_000), "utf8");
      writeFileSync(
        join(dir, "logs", "latest-session.txt"),
        "log=logs/event-purity-production-fresh.log\nprefix=event-purity-production\nsimulation_mode=false\n",
        "utf8",
      );

      const result = spawnSync(process.execPath, [script], {
        encoding: "utf8",
        env: { ...process.env, REPO_ROOT: dir },
      });
      expect(result.status).toBe(0);
      const out = result.stdout.trim().replace(/\\/g, "/");
      expect(out).toContain("event-purity-production-fresh.log");
      expect(out).not.toContain("soak-old");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

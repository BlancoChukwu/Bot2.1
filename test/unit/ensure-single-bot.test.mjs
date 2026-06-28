import { describe, expect, it } from "vitest";

function isBotCommandLine(cmd) {
  if (!cmd) return false;
  const normalized = cmd.trim();
  if (/^(sh|bash|dash|zsh)\s+-c/i.test(normalized)) return false;
  if (/pgrep|grep|ensure-single-bot|watch-bot/i.test(normalized)) return false;
  if (/\bnode\s+\S*dist[\\/]src[\\/]index\.js(?:\s|$|>>)/i.test(normalized)) {
    return true;
  }
  return /\bts-node\b/i.test(normalized) && /\bindex\.ts\b/i.test(normalized);
}

describe("ensure-single-bot process matching", () => {
  it("accepts the real bot command line", () => {
    expect(isBotCommandLine("node dist/src/index.js")).toBe(true);
    expect(isBotCommandLine("node /home/ubuntu/liquidator/dist/src/index.js >> log")).toBe(true);
  });

  it("rejects pgrep and shell wrappers that embed the pattern", () => {
    expect(isBotCommandLine("sh -c pgrep -af 'dist/src/index.js|ts-node.*index.ts'")).toBe(false);
    expect(isBotCommandLine("bash -c node dist/src/index.js")).toBe(false);
    expect(isBotCommandLine("node scripts/ensure-single-bot.mjs --status")).toBe(false);
  });
});

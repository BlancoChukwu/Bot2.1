import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("preflight-event-purity-env", () => {
  let tempDir = "";

  afterEach(async () => {
    if (tempDir.length > 0) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = "";
    }
  });

  it("passes when required event-purity keys are set", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "preflight-ep-"));
    const envPath = join(tempDir, ".env");
    await writeFile(envPath, [
      "CHAIN=base",
      "USE_EVENT_WATCHLIST=true",
      "USE_PIPELINE_ORCHESTRATOR=true",
      "FLASHBLOCKS_ENABLED=true",
      "WS_RPC_URL_PRIMARY=wss://flashblocks.example",
      "EXECUTION_RPC_URL_PRIMARY=https://exec.example",
      "ENABLE_LIVE_TX=false",
    ].join("\n"));

    const { stdout } = await execFileAsync("node", [
      "scripts/preflight-event-purity-env.mjs",
      envPath,
    ], { cwd: process.cwd() });
    expect(stdout).toContain("preflight_event_purity_ok");
  });

  it("fails when flashblocks ws url is missing", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "preflight-ep-"));
    const envPath = join(tempDir, ".env");
    await writeFile(envPath, [
      "USE_EVENT_WATCHLIST=true",
      "USE_PIPELINE_ORCHESTRATOR=true",
      "FLASHBLOCKS_ENABLED=true",
      "RPC_URL=https://rpc.example",
    ].join("\n"));

    await expect(execFileAsync("node", [
      "scripts/preflight-event-purity-env.mjs",
      envPath,
    ], { cwd: process.cwd() })).rejects.toMatchObject({ code: 1 });
  });
});

#!/usr/bin/env node
/**
 * Receiver fork-test gate: load profile env, verify RPC + anvil, run vitest fork suite.
 *
 * Usage:
 *   DOTENV_CONFIG_PATH=.env.event-purity-production npm run test:receiver-fork
 */
import { execSync, spawnSync } from "node:child_process";
import { config } from "dotenv";
import { assertDotenvPathExists } from "./env-profile-path.mjs";

function resolveForkRpc() {
  const candidates = [
    process.env.BASE_FORK_RPC_URL,
    process.env.FORK_RPC_URL,
    process.env.EXECUTION_RPC_URL_PRIMARY,
    process.env.RPC_URL,
    process.env.DEPLOY_RECEIVER_RPC_URL,
  ];
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (trimmed !== undefined && trimmed.length > 0) {
      return trimmed;
    }
  }
  return undefined;
}

function requireCommand(command, installHint) {
  try {
    execSync(`command -v ${command}`, { stdio: "ignore" });
  } catch {
    console.error(JSON.stringify({
      event: "receiver_fork_prereq_missing",
      command,
      installHint,
    }, null, 2));
    process.exit(2);
  }
}

const envPath = assertDotenvPathExists();
config({ path: envPath });

const forkRpc = resolveForkRpc();
if (forkRpc === undefined) {
  console.error(JSON.stringify({
    event: "receiver_fork_prereq_missing",
    reason: "no_base_fork_rpc",
    envFile: envPath,
    hint: "Set RPC_URL or BASE_FORK_RPC_URL in the selected dotenv profile",
  }, null, 2));
  process.exit(2);
}

requireCommand(
  "anvil",
  "Install Foundry: curl -L https://foundry.paradigm.xyz | bash && source ~/.bashrc && foundryup",
);

console.log(JSON.stringify({
  event: "receiver_fork_tests_starting",
  envFile: envPath,
  rpcHost: new URL(forkRpc).host,
}, null, 2));

const result = spawnSync(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["vitest", "run", "test/integration/liquidationFlashReceiver.fork.test.ts"],
  { stdio: "inherit", env: process.env },
);

process.exit(result.status ?? 1);

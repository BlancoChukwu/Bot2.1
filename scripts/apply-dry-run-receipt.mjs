#!/usr/bin/env node
/**
 * Writes DRY_RUN_CONFIG_HASH and DRY_RUN_VALIDATED_AT_MS into .env (does not print secrets).
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const receipt = execSync("npx ts-node scripts/print-dry-run-receipt.ts --quiet", {
  encoding: "utf8",
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
});

const lines = receipt.split(/\r?\n/);
const values = {};
for (const line of lines) {
  const i = line.indexOf("=");
  if (i <= 0) continue;
  values[line.slice(0, i)] = line.slice(i + 1);
}

const envPath = join(root, ".env");
let content = readFileSync(envPath, "utf8");
const updates = {
  DRY_RUN_CONFIG_HASH: values.DRY_RUN_CONFIG_HASH,
  DRY_RUN_VALIDATED_AT_MS: values.DRY_RUN_VALIDATED_AT_MS,
  DRY_RUN_CHAINS: values.DRY_RUN_CHAINS ?? "base",
  DRY_RUN_SUCCESS: process.argv.includes("--mark-success") ? "true" : "false",
};

for (const [key, val] of Object.entries(updates)) {
  if (val === undefined) {
    console.error(`Missing ${key} from receipt`);
    process.exit(1);
  }
  const re = new RegExp(`^${key}=.*$`, "m");
  const line = `${key}=${val}`;
  content = re.test(content) ? content.replace(re, line) : `${content.trimEnd()}\n${line}\n`;
}

writeFileSync(envPath, content, "utf8");
console.log("Updated .env:", Object.keys(updates).join(", "));
console.log("DRY_RUN_SUCCESS=" + updates.DRY_RUN_SUCCESS);

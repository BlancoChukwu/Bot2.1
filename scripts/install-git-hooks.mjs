#!/usr/bin/env node
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

const repoRoot = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
const hooksDir = join(repoRoot, ".git", "hooks");
const hookPath = join(hooksDir, "pre-commit");

const hookBody = `#!/bin/sh
# Installed by: npm run hooks:install
set -e
cd "$(git rev-parse --show-toplevel)"
node scripts/secret-scan.mjs
`;

mkdirSync(hooksDir, { recursive: true });
writeFileSync(hookPath, hookBody, { encoding: "utf8" });
chmodSync(hookPath, 0o755);

console.log(`Installed pre-commit hook: ${hookPath}`);
console.log("Commits will be scanned for private keys and non-template .env files.");

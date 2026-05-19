#!/usr/bin/env node
/**
 * Blocks commits that contain wallet keys or other spendable secrets.
 * Run manually: npm run secret-scan
 * Installed via: npm run hooks:install (pre-commit)
 */
import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { basename, relative } from "node:path";

const PLACEHOLDER_PRIVATE_KEYS = new Set([
  "0x0000000000000000000000000000000000000000000000000000000000000000",
  "0x0000000000000000000000000000000000000000000000000000000000000001",
]);

const ENV_TEMPLATE_PREFIX = ".env.example";

const PRIVATE_KEY_ASSIGNMENT = /^\s*PRIVATE_KEY\s*=\s*(.+)\s*$/gim;
const RAW_32_BYTE_HEX = /\b0x[a-fA-F0-9]{64}\b/g;

const SENSITIVE_ENV_FILES = /^\.env(\.|$)/;

function repoRoot() {
  return execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
}

function listStagedFiles(root) {
  const out = execSync("git diff --cached --name-only --diff-filter=ACM", {
    encoding: "utf8",
    cwd: root,
  }).trim();
  if (out === "") {
    return [];
  }
  return out.split(/\r?\n/).filter(Boolean);
}

function isEnvTemplate(relativePath) {
  const name = basename(relativePath);
  return name === ENV_TEMPLATE_PREFIX || name.startsWith(`${ENV_TEMPLATE_PREFIX}.`);
}

function isBlockedEnvFile(relativePath) {
  const name = basename(relativePath);
  if (!SENSITIVE_ENV_FILES.test(name)) {
    return false;
  }
  return !isEnvTemplate(relativePath);
}

function normalizePrivateKey(raw) {
  const trimmed = raw.trim().replace(/^['"]|['"]$/g, "");
  return trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
}

function scanPrivateKeyAssignments(relativePath, content, findings) {
  for (const match of content.matchAll(PRIVATE_KEY_ASSIGNMENT)) {
    const key = normalizePrivateKey(match[1]);
    if (key.length !== 66) {
      continue;
    }
    if (PLACEHOLDER_PRIVATE_KEYS.has(key.toLowerCase())) {
      continue;
    }
    findings.push({
      file: relativePath,
      reason: "PRIVATE_KEY assignment is not an allowed placeholder (burner keys must stay in .env only)",
    });
  }
}

function scanRawPrivateKeys(relativePath, content, findings) {
  if (isEnvTemplate(relativePath)) {
    return;
  }
  if (relativePath.includes("test/") || relativePath.includes("test\\")) {
    return;
  }
  if (relativePath.includes("contracts/build/")) {
    return;
  }

  for (const match of content.matchAll(RAW_32_BYTE_HEX)) {
    const key = match[0].toLowerCase();
    if (PLACEHOLDER_PRIVATE_KEYS.has(key)) {
      continue;
    }
    findings.push({
      file: relativePath,
      reason: "32-byte hex string that may be a private key (use placeholders in committed files)",
    });
    break;
  }
}

function scanFile(root, relativePath) {
  const findings = [];
  const absolutePath = `${root}/${relativePath}`.replace(/\//g, "/");

  if (isBlockedEnvFile(relativePath)) {
    findings.push({
      file: relativePath,
      reason: "real .env files must not be committed (use .env.example templates only)",
    });
    return findings;
  }

  if (!existsSync(absolutePath)) {
    return findings;
  }

  let content;
  try {
    content = readFileSync(absolutePath, "utf8");
  } catch {
    return findings;
  }

  scanPrivateKeyAssignments(relativePath, content, findings);
  scanRawPrivateKeys(relativePath, content, findings);
  return findings;
}

function main() {
  let root;
  try {
    root = repoRoot();
  } catch {
    console.error("secret-scan: not inside a git repository");
    process.exit(1);
  }

  const files = listStagedFiles(root);
  if (files.length === 0) {
    process.exit(0);
  }

  const allFindings = [];
  for (const file of files) {
    const rel = relative(root, `${root}/${file}`).replace(/\\/g, "/");
    allFindings.push(...scanFile(root, rel));
  }

  if (allFindings.length === 0) {
    process.exit(0);
  }

  console.error("secret-scan: commit blocked — possible wallet secret or sensitive env file\n");
  for (const { file, reason } of allFindings) {
    console.error(`  ${file}: ${reason}`);
  }
  console.error("\nNever commit PRIVATE_KEY, .env, RPC URLs with credentials, or bot tokens.");
  console.error("Store secrets only in local .env (gitignored). Use npm run create:burner-wallet locally.");
  process.exit(1);
}

main();

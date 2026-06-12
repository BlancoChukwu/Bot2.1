#!/usr/bin/env node
/**
 * Merge missing keys from .env.example into a target env file, preserving existing values.
 * Usage: node scripts/merge-env-from-example.mjs [--target .env] [--dry-run]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const examplePath = resolve(root, ".env.example");

const KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/**
 * @param {string} line
 * @returns {{ type: "other" } | { type: "key", key: string, value: string, commented: boolean }}
 */
export function parseEnvLine(line) {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return { type: "other" };
  }

  let body = trimmed;
  let commented = false;
  if (trimmed.startsWith("#")) {
    const withoutHash = trimmed.slice(1).trimStart();
    const maybeKey = withoutHash.split("=", 1)[0]?.trim() ?? "";
    if (!KEY_PATTERN.test(maybeKey)) {
      return { type: "other" };
    }
    commented = true;
    body = withoutHash;
  }

  const eq = body.indexOf("=");
  if (eq === -1) {
    return { type: "other" };
  }

  const key = body.slice(0, eq).trim();
  if (!KEY_PATTERN.test(key)) {
    return { type: "other" };
  }

  return {
    type: "key",
    key,
    value: body.slice(eq + 1),
    commented,
  };
}

/**
 * @param {string} content
 * @returns {Map<string, { value: string }>}
 */
export function parseActiveEnvEntries(content) {
  const entries = new Map();
  for (const line of content.split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (parsed.type === "key" && !parsed.commented) {
      entries.set(parsed.key, { value: parsed.value });
    }
  }
  return entries;
}

/**
 * @param {string} exampleContent
 * @param {string | undefined} targetContent
 * @returns {string}
 */
export function mergeEnvFromExample(exampleContent, targetContent) {
  const targetEntries = parseActiveEnvEntries(targetContent ?? "");
  const exampleKeys = new Set();
  const out = [];

  for (const line of exampleContent.split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (parsed.type !== "key") {
      out.push(line);
      continue;
    }

    exampleKeys.add(parsed.key);
    const existing = targetEntries.get(parsed.key);
    if (existing) {
      out.push(`${parsed.key}=${existing.value}`);
      targetEntries.delete(parsed.key);
    } else {
      out.push(line);
    }
  }

  if (targetEntries.size > 0) {
    out.push("");
    out.push("# --- Keys present in target but not in .env.example ---");
    for (const [key, { value }] of targetEntries) {
      out.push(`${key}=${value}`);
    }
  }

  const merged = out.join("\n");
  return merged.endsWith("\n") ? merged : `${merged}\n`;
}

function parseArgs(argv) {
  let target = process.env.ENV_MERGE_TARGET?.trim();
  let dryRun = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--target" && argv[i + 1]) {
      target = argv[i + 1];
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: node scripts/merge-env-from-example.mjs [--target .env] [--dry-run]

Merges missing keys from .env.example into the target file. Existing key values are preserved.
Orphan keys (only in target) are appended at the end.

Environment:
  ENV_MERGE_TARGET   default target path when --target is omitted`);
      process.exit(0);
    }
  }

  if (!target) {
    const candidates = [".env", ".env.production", ".env.simulation"];
    target = candidates.find((name) => existsSync(resolve(root, name))) ?? ".env";
  }

  return {
    targetPath: resolve(root, target),
    dryRun,
  };
}

function main() {
  if (!existsSync(examplePath)) {
    console.error("merge_env_from_example: .env.example not found");
    process.exit(1);
  }

  const { targetPath, dryRun } = parseArgs(process.argv.slice(2));
  const exampleContent = readFileSync(examplePath, "utf8");
  const hadTarget = existsSync(targetPath);
  const targetContent = hadTarget ? readFileSync(targetPath, "utf8") : undefined;
  const merged = mergeEnvFromExample(exampleContent, targetContent);

  const beforeKeys = new Set(parseActiveEnvEntries(targetContent ?? "").keys());
  const afterKeys = new Set(parseActiveEnvEntries(merged).keys());
  const addedKeys = [...afterKeys].filter((key) => !beforeKeys.has(key));

  if (dryRun) {
    process.stdout.write(merged);
    return;
  }

  writeFileSync(targetPath, merged, "utf8");
  console.log(
    JSON.stringify(
      {
        msg: "merge_env_from_example_complete",
        target: targetPath,
        created: !hadTarget,
        addedKeys,
        orphanKeys: merged.includes("# --- Keys present in target but not in .env.example ---"),
      },
      null,
      2,
    ),
  );
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  main();
}

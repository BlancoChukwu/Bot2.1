#!/usr/bin/env node
/**
 * Ensure at most one liquidation bot Node process for this repo.
 * Usage: node scripts/ensure-single-bot.mjs [--status|--stop]
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const lockPath = join(repoRoot, ".runtime", "bot.lock");
const mode = process.argv.includes("--status") ? "status" : "stop";

function isBotCommandLine(cmd) {
  if (!cmd) return false;
  if (/dist[\\/]src[\\/]index\.js/i.test(cmd)) return true;
  return /ts-node/i.test(cmd) && /index\.ts/i.test(cmd);
}

function parseLockPid() {
  if (!existsSync(lockPath)) return undefined;
  const line = readFileSync(lockPath, "utf8").trim().split(/\s+/)[0];
  const pid = Number(line);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

function listBotProcesses() {
  if (process.platform === "win32") {
    const ps = [
      "Get-CimInstance Win32_Process -Filter \"name='node.exe'\"",
      "| Where-Object {",
      "  $_.CommandLine -like '*dist*src*index.js*' -or",
      "  ($_.CommandLine -like '*index.ts*' -and $_.CommandLine -like '*ts-node*')",
      "}",
      "| ForEach-Object { Write-Output ($_.ProcessId.ToString() + '|' + $_.CommandLine) }",
    ].join(" ");
    try {
      const out = execSync(`powershell -NoProfile -Command ${JSON.stringify(ps)}`, {
        encoding: "utf8",
        cwd: repoRoot,
        stdio: ["ignore", "pipe", "ignore"],
      });
      return out
        .trim()
        .split(/\r?\n/)
        .filter((line) => line.includes("|"))
        .map((line) => {
          const sep = line.indexOf("|");
          return {
            pid: Number(line.slice(0, sep)),
            cmd: line.slice(sep + 1),
          };
        })
        .filter((row) => Number.isInteger(row.pid) && row.pid > 0);
    } catch {
      return [];
    }
  }

  try {
    const out = execSync("pgrep -af 'dist/src/index.js|ts-node.*index.ts'", {
      encoding: "utf8",
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const match = line.match(/^(\d+)\s+(.*)$/);
        if (!match) return null;
        const pid = Number(match[1]);
        const cmd = match[2];
        if (!isBotCommandLine(cmd)) return null;
        return { pid, cmd };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function removeStaleLock() {
  const lockPid = parseLockPid();
  if (lockPid === undefined) {
    if (existsSync(lockPath)) {
      unlinkSync(lockPath);
      return { removed: true, reason: "empty_lock" };
    }
    return { removed: false, reason: "no_lock" };
  }
  if (!isAlive(lockPid)) {
    unlinkSync(lockPath);
    return { removed: true, reason: "stale_pid", stalePid: lockPid };
  }
  return { removed: false, reason: "held", pid: lockPid };
}

function stopBots() {
  const processes = listBotProcesses();
  const killed = new Set();
  for (const proc of processes) {
    try {
      process.kill(proc.pid, "SIGINT");
    } catch (error) {
      if (error.code !== "ESRCH") {
        killed.add(proc.pid);
      }
    }
  }

  const gracefulDeadlineMs = Date.now() + 8_000;
  while (Date.now() < gracefulDeadlineMs) {
    const remaining = listBotProcesses();
    if (remaining.length === 0) {
      break;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }

  for (const proc of listBotProcesses()) {
    try {
      process.kill(proc.pid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") {
        killed.add(proc.pid);
      }
    }
  }

  for (const proc of listBotProcesses()) {
    try {
      process.kill(proc.pid);
      killed.add(proc.pid);
    } catch (error) {
      if (error.code !== "ESRCH") {
        killed.add(proc.pid);
      }
    }
  }

  const lockPid = parseLockPid();
  if (lockPid !== undefined && isAlive(lockPid) && !killed.has(lockPid)) {
    try {
      process.kill(lockPid);
      killed.add(lockPid);
    } catch (error) {
      if (error.code !== "ESRCH") {
        killed.add(lockPid);
      }
    }
  }

  const lock = removeStaleLock();
  return { killed: [...killed], lock, remaining: listBotProcesses() };
}

function status() {
  const processes = listBotProcesses();
  const lockPid = parseLockPid();
  return {
    lockPath,
    lockPid,
    lockHolderAlive: lockPid !== undefined ? isAlive(lockPid) : false,
    botProcesses: processes,
    count: processes.length,
    singleInstance: processes.length <= 1,
  };
}

const result = mode === "status" ? status() : stopBots();
console.log(JSON.stringify(result, null, 2));
process.exit(mode === "status" && result.count > 1 ? 2 : 0);

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface SingleInstanceLock {
  readonly lockPath: string;
  release(): void;
}

export interface SingleInstanceLockOptions {
  readonly lockPath: string;
  readonly pid?: number;
}

/**
 * Acquire an exclusive PID lock file. Returns null when another live instance holds the lock.
 */
export function acquireSingleInstanceLock(options: SingleInstanceLockOptions): SingleInstanceLock | null {
  const pid = options.pid ?? process.pid;
  mkdirSync(dirname(options.lockPath), { recursive: true });

  if (existsSync(options.lockPath)) {
    const existingPid = parseLockPid(readFileSync(options.lockPath, "utf8"));
    if (existingPid !== undefined && isProcessAlive(existingPid)) {
      if (existingPid === pid) {
        return {
          lockPath: options.lockPath,
          release() {
            // Re-entrant acquire in the same process; released on final shutdown hook.
          },
        };
      }
      return null;
    }
    try {
      unlinkSync(options.lockPath);
    } catch {
      return null;
    }
  }

  let fd: number;
  try {
    fd = openSync(options.lockPath, "wx");
  } catch {
    return null;
  }

  try {
    writeFileSync(fd, `${pid}\n`, "utf8");
  } finally {
    closeSync(fd);
  }

  return {
    lockPath: options.lockPath,
    release() {
      try {
        if (existsSync(options.lockPath)) {
          const current = parseLockPid(readFileSync(options.lockPath, "utf8"));
          if (current === pid) {
            unlinkSync(options.lockPath);
          }
        }
      } catch {
        // Best-effort unlock on shutdown.
      }
    },
  };
}

function parseLockPid(contents: string): number | undefined {
  const line = contents.trim().split(/\s+/)[0];
  if (line === undefined || line.length === 0) {
    return undefined;
  }
  const parsed = Number(line);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code !== "ESRCH";
  }
}

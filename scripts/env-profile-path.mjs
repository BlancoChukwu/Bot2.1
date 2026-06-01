import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Resolves which dotenv file launchers and helpers should load.
 * Priority: DOTENV_CONFIG_PATH > BOT_ENV_FILE > .env
 */
export function resolveDotenvPath(cwd = process.cwd()) {
  const explicit = process.env.DOTENV_CONFIG_PATH?.trim();
  if (explicit !== undefined && explicit.length > 0) {
    return resolve(cwd, explicit);
  }
  const profile = process.env.BOT_ENV_FILE?.trim();
  if (profile !== undefined && profile.length > 0) {
    return resolve(cwd, profile);
  }
  return resolve(cwd, ".env");
}

export function assertDotenvPathExists(cwd = process.cwd()) {
  const path = resolveDotenvPath(cwd);
  if (!existsSync(path)) {
    throw new Error(`env_file_missing: ${path}`);
  }
  return path;
}

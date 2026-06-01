import { afterEach, describe, expect, it } from "vitest";
import { resolveDotenvPath } from "../../scripts/env-profile-path.mjs";

describe("envProfilePath", () => {
  afterEach(() => {
    delete process.env.DOTENV_CONFIG_PATH;
    delete process.env.BOT_ENV_FILE;
  });

  it("prefers DOTENV_CONFIG_PATH", () => {
    process.env.DOTENV_CONFIG_PATH = ".env.production";
    expect(resolveDotenvPath("/repo")).toMatch(/\.env\.production$/);
  });

  it("falls back to BOT_ENV_FILE", () => {
    process.env.BOT_ENV_FILE = ".env.simulation";
    expect(resolveDotenvPath("/repo")).toMatch(/\.env\.simulation$/);
  });
});

import { describe, expect, it } from "vitest";
import {
  mergeEnvFromExample,
  parseActiveEnvEntries,
  parseEnvLine,
} from "../../scripts/merge-env-from-example.mjs";

describe("parseEnvLine", () => {
  it("parses active keys", () => {
    expect(parseEnvLine("RPC_URL=https://example")).toEqual({
      type: "key",
      key: "RPC_URL",
      value: "https://example",
      commented: false,
    });
  });

  it("parses commented optional keys", () => {
    expect(parseEnvLine("# POLL_INTERVAL_MS=400")).toEqual({
      type: "key",
      key: "POLL_INTERVAL_MS",
      value: "400",
      commented: true,
    });
  });

  it("treats section comments as other", () => {
    expect(parseEnvLine("# --- Chain ---")).toEqual({ type: "other" });
  });
});

describe("mergeEnvFromExample", () => {
  const example = `# --- Chain ---
CHAIN=base
# OPTIONAL_KEY=1
RPC_URL=https://template.example
POLL_INTERVAL_MS=400
`;

  it("preserves existing values and adds missing keys from example", () => {
    const target = `CHAIN=optimism
RPC_URL=https://mine.example
`;

    const merged = mergeEnvFromExample(example, target);
    expect(merged).toContain("CHAIN=optimism");
    expect(merged).toContain("RPC_URL=https://mine.example");
    expect(merged).toContain("# OPTIONAL_KEY=1");
    expect(merged).toContain("POLL_INTERVAL_MS=400");
  });

  it("appends orphan keys from target", () => {
    const target = `CHAIN=base
FORK_RPC_URL=https://fork.example
`;

    const merged = mergeEnvFromExample(example, target);
    expect(merged).toContain("# --- Keys present in target but not in .env.example ---");
    expect(merged).toContain("FORK_RPC_URL=https://fork.example");
  });

  it("preserves json hash values", () => {
    const hash = '{"chains":["base"],"pollIntervalMs":"400"}';
    const target = `DRY_RUN_CONFIG_HASH=${hash}
`;

    const merged = mergeEnvFromExample(
      `DRY_RUN_CONFIG_HASH=\nOTHER=value\n`,
      target,
    );
    expect(merged).toContain(`DRY_RUN_CONFIG_HASH=${hash}`);
  });

  it("creates output from example when target is empty", () => {
    const merged = mergeEnvFromExample(example, "");
    expect(parseActiveEnvEntries(merged).get("CHAIN")?.value).toBe("base");
    expect(merged).toContain("POLL_INTERVAL_MS=400");
  });
});

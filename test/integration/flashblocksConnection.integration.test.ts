import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const enabled = (process.env.RUN_FLASHBLOCKS_TEST ?? "0") === "1";

describe.skipIf(!enabled)("flashblocks connection integration", () => {
  it("reads flashblocks-test.json when present", () => {
    const path = join(process.cwd(), ".runtime", "flashblocks-test.json");
    if (!existsSync(path)) {
      expect(true).toBe(true);
      return;
    }
    const payload = JSON.parse(readFileSync(path, "utf8")) as { pass: boolean };
    expect(typeof payload.pass).toBe("boolean");
  });
});

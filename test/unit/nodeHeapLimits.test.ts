import { afterEach, describe, expect, it } from "vitest";
import { memoryLimitsFromNodeHeap, parseMaxOldSpaceSizeMb } from "../../src/utils/nodeHeapLimits";

describe("nodeHeapLimits", () => {
  const original = process.env.NODE_OPTIONS;

  afterEach(() => {
    process.env.NODE_OPTIONS = original;
  });

  it("parses max old space size from NODE_OPTIONS", () => {
    process.env.NODE_OPTIONS = "--max-old-space-size=650 --expose-gc";
    expect(parseMaxOldSpaceSizeMb()).toBe(650);
  });

  it("derives warn and ceil bytes from heap cap", () => {
    const limits = memoryLimitsFromNodeHeap(650);
    expect(limits.warnBytes).toBe(Math.floor(650 * 0.72) * 1024 * 1024);
    expect(limits.ceilBytes).toBe(Math.floor(650 * 0.9) * 1024 * 1024);
    expect(limits.rssWarnBytes).toBe(380 * 1024 * 1024);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../../src/bot";
import { sampleMemoryUsage, startMemoryMonitor } from "../../src/utils/memoryMonitor";

describe("memoryMonitor", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports warn and ceiling actions from heap usage", () => {
    const usageSpy = vi.spyOn(process, "memoryUsage").mockReturnValue({
      heapUsed: 150,
      heapTotal: 200,
      rss: 300,
      external: 0,
      arrayBuffers: 0,
    });
    const warn = sampleMemoryUsage({ warnBytes: 100, ceilBytes: 200 });
    expect(warn.action).toBe("warn");

    usageSpy.mockReturnValue({
      heapUsed: 250,
      heapTotal: 300,
      rss: 400,
      external: 0,
      arrayBuffers: 0,
    });
    const ceiling = sampleMemoryUsage({ warnBytes: 100, ceilBytes: 200 });
    expect(ceiling.action).toBe("ceiling");
    usageSpy.mockRestore();
  });

  it("checkNow triggers ceiling handler without waiting for interval", () => {
    const exit = vi.fn((_code: number) => undefined as never);
    const onCeilingHit = vi.fn();
    const logger = createLogger("silent");
    const monitor = startMemoryMonitor({
      logger,
      warnBytes: 1,
      ceilBytes: 1,
      intervalMs: 60_000,
      onCeilingHit,
      exitProcess: exit,
    });

    monitor.checkNow();
    expect(onCeilingHit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    monitor.stop();
  });

  it("emits memory_stats on interval ticks", () => {
    vi.useFakeTimers();
    const info = vi.fn();
    const logger = { info, warn: vi.fn(), error: vi.fn() };
    const monitor = startMemoryMonitor({
      logger,
      warnBytes: Number.MAX_SAFE_INTEGER,
      ceilBytes: Number.MAX_SAFE_INTEGER,
      intervalMs: 1_000,
    });

    vi.advanceTimersByTime(1_000);
    expect(info).toHaveBeenCalledWith("memory_stats", expect.objectContaining({ heapUsedMb: expect.any(Number) }));
    monitor.stop();
    vi.useRealTimers();
  });
});

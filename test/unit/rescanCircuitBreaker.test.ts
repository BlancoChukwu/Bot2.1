import { describe, expect, it, vi } from "vitest";
import { RescanCircuitBreaker } from "../../src/monitors/rescanCircuitBreaker";

describe("RescanCircuitBreaker", () => {
  it("opens after threshold failures and sheds load during cooldown", async () => {
    vi.useFakeTimers();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const breaker = new RescanCircuitBreaker({ threshold: 3, cooldownMs: 30_000, logger });
    const onFailure = vi.fn();
    const task = vi.fn().mockRejectedValue(new Error("graph down"));

    await breaker.execute(task, onFailure);
    await breaker.execute(task, onFailure);
    await breaker.execute(task, onFailure);
    expect(onFailure).toHaveBeenCalledTimes(3);
    expect(logger.warn).toHaveBeenCalledWith(
      "watchlist_circuit_breaker_open",
      expect.objectContaining({ failures: 3 }),
    );

    onFailure.mockClear();
    await breaker.execute(task, onFailure);
    expect(onFailure).not.toHaveBeenCalled();
    expect(task).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(30_000);
    task.mockResolvedValueOnce(undefined);
    await breaker.execute(task, onFailure);
    expect(task).toHaveBeenCalledTimes(4);
    breaker.stop();
    vi.useRealTimers();
  });
});

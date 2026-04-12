import { describe, it, expect, vi } from "vitest";
import { parseRetryAfter, withRetry } from "../../src/utils/retry.js";

describe("withRetry", () => {
  it("returns result on first success", async () => {
    const fn = vi.fn<() => Promise<string>>().mockResolvedValue("ok");
    const result = await withRetry(fn);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on failure and succeeds", async () => {
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("fail"))
      .mockResolvedValueOnce("ok");
    const result = await withRetry(fn, { baseDelay: 1, jitter: false });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("throws after max attempts exhausted", async () => {
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(new Error("always fails"));
    await expect(
      withRetry(fn, { maxAttempts: 3, baseDelay: 1, jitter: false })
    ).rejects.toThrow("always fails");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("respects isRetryable predicate", async () => {
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(new Error("not retryable"));
    await expect(
      withRetry(fn, {
        maxAttempts: 3,
        baseDelay: 1,
        isRetryable: () => false,
      })
    ).rejects.toThrow("not retryable");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("uses exponential backoff timing", async () => {
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("fail"))
      .mockRejectedValueOnce(new Error("fail"))
      .mockResolvedValueOnce("ok");

    const start = Date.now();
    await withRetry(fn, { baseDelay: 50, jitter: false, maxDelay: 200 });
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(100);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("caps delay at maxDelay", async () => {
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("fail"))
      .mockResolvedValueOnce("ok");

    const start = Date.now();
    await withRetry(fn, { baseDelay: 1000, maxDelay: 10, jitter: false });
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(100);
  });
});

describe("parseRetryAfter", () => {
  it("parses delta-seconds integer", () => {
    expect(parseRetryAfter("120")).toBe(120);
  });

  it("parses HTTP-date relative to now", () => {
    const future = new Date(Date.now() + 90_000).toUTCString();
    const result = parseRetryAfter(future);
    expect(result).toBeGreaterThanOrEqual(88);
    expect(result).toBeLessThanOrEqual(91);
  });

  it("clamps past HTTP-dates to zero", () => {
    const past = new Date(Date.now() - 60_000).toUTCString();
    expect(parseRetryAfter(past)).toBe(0);
  });

  it("returns fallback on null/undefined/empty", () => {
    expect(parseRetryAfter(null)).toBe(60);
    expect(parseRetryAfter(undefined)).toBe(60);
    expect(parseRetryAfter("")).toBe(60);
    expect(parseRetryAfter(null, 10)).toBe(10);
  });

  it("returns fallback on unparseable garbage", () => {
    expect(parseRetryAfter("not a date nor a number", 42)).toBe(42);
  });

  it("rejects negative delta-seconds", () => {
    expect(parseRetryAfter("-5", 30)).toBe(30);
  });
});

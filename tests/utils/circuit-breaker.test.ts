import { describe, it, expect, beforeEach } from "vitest";
import { CircuitBreaker } from "../../src/utils/circuit-breaker.js";

describe("CircuitBreaker", () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    breaker = new CircuitBreaker({ failureThreshold: 3, resetTimeout: 100 });
  });

  it("starts in CLOSED state", () => {
    expect(breaker.getState()).toBe("CLOSED");
  });

  it("stays CLOSED on successful calls", async () => {
    await breaker.execute(() => Promise.resolve("ok"));
    await breaker.execute(() => Promise.resolve("ok"));
    expect(breaker.getState()).toBe("CLOSED");
  });

  it("opens after reaching failure threshold", async () => {
    const fail = () => Promise.reject(new Error("fail"));
    for (let i = 0; i < 3; i++) {
      await breaker.execute(fail).catch(() => {});
    }
    expect(breaker.getState()).toBe("OPEN");
  });

  it("rejects calls when OPEN", async () => {
    const fail = () => Promise.reject(new Error("fail"));
    for (let i = 0; i < 3; i++) {
      await breaker.execute(fail).catch(() => {});
    }
    await expect(
      breaker.execute(() => Promise.resolve("ok"))
    ).rejects.toThrow("Circuit breaker is OPEN");
  });

  it("transitions to HALF_OPEN after reset timeout", async () => {
    const fail = () => Promise.reject(new Error("fail"));
    for (let i = 0; i < 3; i++) {
      await breaker.execute(fail).catch(() => {});
    }
    expect(breaker.getState()).toBe("OPEN");

    await new Promise((r) => setTimeout(r, 150));
    expect(breaker.getState()).toBe("HALF_OPEN");
  });

  it("closes from HALF_OPEN after successful call", async () => {
    const fail = () => Promise.reject(new Error("fail"));
    for (let i = 0; i < 3; i++) {
      await breaker.execute(fail).catch(() => {});
    }

    await new Promise((r) => setTimeout(r, 150));
    expect(breaker.getState()).toBe("HALF_OPEN");

    await breaker.execute(() => Promise.resolve("ok"));
    expect(breaker.getState()).toBe("CLOSED");
  });

  it("reopens from HALF_OPEN on failure", async () => {
    const fail = () => Promise.reject(new Error("fail"));
    for (let i = 0; i < 3; i++) {
      await breaker.execute(fail).catch(() => {});
    }

    await new Promise((r) => setTimeout(r, 150));
    expect(breaker.getState()).toBe("HALF_OPEN");

    await breaker.execute(fail).catch(() => {});
    expect(breaker.getState()).toBe("OPEN");
  });

  it("resets failure count on success in CLOSED state", async () => {
    const fail = () => Promise.reject(new Error("fail"));
    await breaker.execute(fail).catch(() => {});
    await breaker.execute(fail).catch(() => {});
    await breaker.execute(() => Promise.resolve("ok"));
    await breaker.execute(fail).catch(() => {});
    await breaker.execute(fail).catch(() => {});
    expect(breaker.getState()).toBe("CLOSED");
  });

  it("reset() method restores to CLOSED", async () => {
    const fail = () => Promise.reject(new Error("fail"));
    for (let i = 0; i < 3; i++) {
      await breaker.execute(fail).catch(() => {});
    }
    expect(breaker.getState()).toBe("OPEN");
    breaker.reset();
    expect(breaker.getState()).toBe("CLOSED");
  });
});

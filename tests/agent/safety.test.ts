import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ApprovalManager } from "../../src/agent/safety.js";

describe("ApprovalManager", () => {
  let mgr: ApprovalManager;

  beforeEach(() => {
    vi.useFakeTimers();
    mgr = new ApprovalManager();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves true when handleResponse approves", async () => {
    const p = mgr.requestApproval("t1", "publish blog", 10_000);
    expect(mgr.getPendingCount()).toBe(1);
    expect(mgr.hasPending("t1")).toBe(true);
    expect(mgr.handleResponse("t1", true)).toBe(true);
    await expect(p).resolves.toBe(true);
    expect(mgr.getPendingCount()).toBe(0);
  });

  it("resolves false when handleResponse rejects", async () => {
    const p = mgr.requestApproval("t2", "publish blog", 10_000);
    mgr.handleResponse("t2", false);
    await expect(p).resolves.toBe(false);
  });

  it("resolves false when the timeout fires before any response", async () => {
    const p = mgr.requestApproval("t3", "publish blog", 5_000);
    vi.advanceTimersByTime(5_001);
    await expect(p).resolves.toBe(false);
    expect(mgr.hasPending("t3")).toBe(false);
  });

  it("handleResponse returns false for an unknown taskId", () => {
    expect(mgr.handleResponse("never-seen", true)).toBe(false);
  });

  it("handleResponse returns false after the timeout already fired", async () => {
    const p = mgr.requestApproval("t4", "publish blog", 1_000);
    vi.advanceTimersByTime(1_001);
    await p;
    expect(mgr.handleResponse("t4", true)).toBe(false);
  });

  it("rejects a duplicate approval request for the same taskId", async () => {
    const first = mgr.requestApproval("dup", "action", 10_000);
    await expect(
      mgr.requestApproval("dup", "action", 10_000),
    ).rejects.toThrow(/Duplicate approval request/);
    // The first promise is still live and can be resolved normally.
    mgr.handleResponse("dup", true);
    await expect(first).resolves.toBe(true);
  });

  it("shutdown() resolves all pending approvals as false and blocks new requests", async () => {
    const a = mgr.requestApproval("a", "x", 60_000);
    const b = mgr.requestApproval("b", "y", 60_000);
    mgr.shutdown();
    await expect(a).resolves.toBe(false);
    await expect(b).resolves.toBe(false);
    expect(mgr.getPendingCount()).toBe(0);

    await expect(
      mgr.requestApproval("after-shutdown", "z", 1_000),
    ).rejects.toThrow(/shutting down/);
  });

  it("shutdown() clears timers so they do not fire later", async () => {
    const p = mgr.requestApproval("t5", "x", 5_000);
    mgr.shutdown();
    await expect(p).resolves.toBe(false);
    // If the timer were still live, advancing would double-resolve. Vitest
    // would not throw, but the Map would be touched — assert it stays empty.
    vi.advanceTimersByTime(10_000);
    expect(mgr.getPendingCount()).toBe(0);
  });
});

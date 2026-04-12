import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { EodinSdkCollector } from "../../src/collectors/eodin-sdk.js";
import { ExternalApiError } from "../../src/utils/errors.js";

interface MockResponse {
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
  text?: () => Promise<string>;
}

function mockResponse(partial: Partial<MockResponse>): MockResponse {
  return {
    ok: partial.ok ?? false,
    status: partial.status ?? 200,
    json: partial.json ?? (() => Promise.resolve({})),
    text: partial.text ?? (() => Promise.resolve("")),
  };
}

describe("EodinSdkCollector", () => {
  const originalFetch = globalThis.fetch;
  let mockFetch: ReturnType<typeof vi.fn>;
  let collector: EodinSdkCollector;

  beforeEach(() => {
    mockFetch = vi.fn();
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    collector = new EodinSdkCollector({ apiKey: "test-key" });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("throws if apiKey is missing", () => {
    expect(() => new EodinSdkCollector({ apiKey: "" })).toThrow(
      /requires apiKey/
    );
  });

  it("sends X-API-Key header and not Authorization: Bearer", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: [] }),
      })
    );

    await collector.getSummary("fridgify", "2026-03-30", "2026-03-30");

    const call = mockFetch.mock.calls[0];
    const init = call?.[1] as { headers: Record<string, string> };
    expect(init.headers["X-API-Key"]).toBe("test-key");
    expect(init.headers.Authorization).toBeUndefined();
  });

  it("getSummary encodes app_id + range + granularity into query string", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            data: [
              {
                date: "2026-03-30",
                installs: 150,
                dau: 1200,
                sessions: 3400,
                core_actions: 890,
                paywall_views: 320,
                subscriptions: 12,
                revenue: 58800,
              },
            ],
          }),
      })
    );

    const rows = await collector.getSummary(
      "fridgify",
      "2026-03-24",
      "2026-03-30"
    );

    const calledUrl = mockFetch.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain("api.eodin.app/api/v1/events/summary");
    expect(calledUrl).toContain("app_id=fridgify");
    expect(calledUrl).toContain("start=2026-03-24");
    expect(calledUrl).toContain("end=2026-03-30");
    expect(calledUrl).toContain("granularity=daily");
    expect(calledUrl).toContain("os=all");

    expect(rows).toHaveLength(1);
    expect(rows[0]?.installs).toBe(150);
    expect(rows[0]?.subscriptions).toBe(12);
  });

  it("getFunnel returns funnel data and defaults os to all", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            data: {
              funnel: [
                {
                  step: "app_install",
                  count: 1500,
                  rate: 1.0,
                  drop_rate: 0.0,
                },
                {
                  step: "subscribe_start",
                  count: 120,
                  rate: 0.08,
                  drop_rate: 0.187,
                },
              ],
              overall_conversion: 0.08,
            },
          }),
      })
    );

    const data = await collector.getFunnel(
      "fridgify",
      "2026-03-24",
      "2026-03-30"
    );

    const calledUrl = mockFetch.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain("/funnel");
    expect(calledUrl).toContain("os=all");
    expect(data.funnel).toHaveLength(2);
    expect(data.funnel[0]?.step).toBe("app_install");
    expect(data.overall_conversion).toBeCloseTo(0.08);
  });

  it("getCohort defaults to weekly granularity and returns cohorts", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            data: {
              cohorts: [
                {
                  cohort_date: "2026-03-01",
                  cohort_size: 500,
                  retention: [1.0, 0.45, 0.32, 0.28, 0.25],
                },
              ],
            },
          }),
      })
    );

    const cohorts = await collector.getCohort(
      "fridgify",
      "2026-03-01",
      "2026-03-31"
    );

    const calledUrl = mockFetch.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain("/cohort");
    expect(calledUrl).toContain("granularity=weekly");
    expect(cohorts).toHaveLength(1);
    expect(cohorts[0]?.cohort_size).toBe(500);
    expect(cohorts[0]?.retention[1]).toBeCloseTo(0.45);
  });

  it("rejects untrusted hosts (SSRF defense-in-depth)", async () => {
    const bad = new EodinSdkCollector(
      { apiKey: "test-key" },
      { baseUrl: "https://evil.example.com/api/v1/events" }
    );

    await expect(
      bad.getSummary("fridgify", "2026-03-30", "2026-03-30")
    ).rejects.toThrow(/Untrusted SDK host/);
  });

  it("throws ExternalApiError on non-ok response", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        ok: false,
        status: 401,
        text: () => Promise.resolve("Unauthorized"),
      })
    );

    const caught = await collector
      .getSummary("fridgify", "2026-03-30", "2026-03-30")
      .catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(ExternalApiError);
    expect((caught as ExternalApiError).statusCode).toBe(401);
  });

  it("returns empty array when summary response has no data field", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ success: true }),
      })
    );

    const rows = await collector.getSummary(
      "fridgify",
      "2026-03-30",
      "2026-03-30"
    );
    expect(rows).toEqual([]);
  });

  it("normalizes percent-encoded cohort retention to fractions", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            data: {
              cohorts: [
                {
                  cohort_date: "2026-03-01",
                  cohort_size: 500,
                  retention: [100, 45, 32, 28, 25],
                },
              ],
            },
          }),
      })
    );

    const cohorts = await collector.getCohort(
      "fridgify",
      "2026-03-01",
      "2026-03-31"
    );
    expect(cohorts[0]?.retention[0]).toBeCloseTo(1.0);
    expect(cohorts[0]?.retention[1]).toBeCloseTo(0.45);
    expect(cohorts[0]?.retention[4]).toBeCloseTo(0.25);
    expect(warnSpy).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
  });

  it("logs the percent-cohort warning only once per collector instance", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const percentBody = {
      data: {
        cohorts: [
          {
            cohort_date: "2026-03-01",
            cohort_size: 500,
            retention: [100, 45, 32, 28, 25],
          },
        ],
      },
    };
    mockFetch.mockResolvedValue(
      mockResponse({
        ok: true,
        status: 200,
        json: () => Promise.resolve(percentBody),
      })
    );

    await collector.getCohort("fridgify", "2026-03-01", "2026-03-31");
    await collector.getCohort("fridgify", "2026-03-01", "2026-03-31");
    await collector.getCohort("fridgify", "2026-03-01", "2026-03-31");

    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it("treats retention[0] === 1.5 as fractional (boundary)", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            data: {
              cohorts: [
                {
                  cohort_date: "2026-03-01",
                  cohort_size: 500,
                  retention: [1.5, 0.8, 0.4],
                },
              ],
            },
          }),
      })
    );

    const cohorts = await collector.getCohort(
      "fridgify",
      "2026-03-01",
      "2026-03-31"
    );
    expect(cohorts[0]?.retention).toEqual([1.5, 0.8, 0.4]);
  });

  it("treats retention[0] === 1.6 as percent-encoded (boundary)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            data: {
              cohorts: [
                {
                  cohort_date: "2026-03-01",
                  cohort_size: 500,
                  retention: [1.6, 0.8, 0.4],
                },
              ],
            },
          }),
      })
    );

    const cohorts = await collector.getCohort(
      "fridgify",
      "2026-03-01",
      "2026-03-31"
    );
    expect(cohorts[0]?.retention[0]).toBeCloseTo(0.016);
    warnSpy.mockRestore();
  });

  it("redacts API key from error-body echoes", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        ok: false,
        status: 401,
        text: () =>
          Promise.resolve(
            `{"error":"Invalid X-API-Key: test-key, rejected"}`
          ),
      })
    );

    const caught = await collector
      .getSummary("fridgify", "2026-03-30", "2026-03-30")
      .catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(ExternalApiError);
    const msg = (caught as ExternalApiError).message;
    expect(msg).not.toContain("test-key");
    expect(msg).toContain("[REDACTED]");
  });

  it("skips empty-string query params (e.g. getFunnel source=\"\")", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({ data: { funnel: [], overall_conversion: 0 } }),
      })
    );

    await collector.getFunnel("fridgify", "2026-03-24", "2026-03-30", {
      source: "",
    });
    const calledUrl = mockFetch.mock.calls[0]?.[0] as string;
    expect(calledUrl).not.toContain("source=");
  });

  it("leaves already-fractional cohort retention untouched", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            data: {
              cohorts: [
                {
                  cohort_date: "2026-03-01",
                  cohort_size: 500,
                  retention: [1.0, 0.45, 0.32, 0.28, 0.25],
                },
              ],
            },
          }),
      })
    );

    const cohorts = await collector.getCohort(
      "fridgify",
      "2026-03-01",
      "2026-03-31"
    );
    expect(cohorts[0]?.retention).toEqual([1.0, 0.45, 0.32, 0.28, 0.25]);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { ArdenTtsClient } from "../../src/collectors/arden-tts.js";
import { ExternalApiError } from "../../src/utils/errors.js";

interface MockResponse {
  ok: boolean;
  status: number;
  arrayBuffer?: () => Promise<ArrayBuffer>;
  text?: () => Promise<string>;
}

function mockResponse(partial: Partial<MockResponse>): MockResponse {
  return {
    ok: partial.ok ?? false,
    status: partial.status ?? 200,
    arrayBuffer:
      partial.arrayBuffer ?? (() => Promise.resolve(new ArrayBuffer(0))),
    text: partial.text ?? (() => Promise.resolve("")),
  };
}

describe("ArdenTtsClient", () => {
  const originalFetch = globalThis.fetch;
  let mockFetch: ReturnType<typeof vi.fn>;
  let client: ArdenTtsClient;

  beforeEach(() => {
    mockFetch = vi.fn();
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    client = new ArdenTtsClient({ endpoint: "https://arden.example.com/" });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("throws if endpoint is missing", () => {
    expect(() => new ArdenTtsClient({ endpoint: "" })).toThrow(
      /requires endpoint/
    );
  });

  it("rejects non-http(s) endpoint schemes", () => {
    expect(
      () => new ArdenTtsClient({ endpoint: "javascript:alert(1)" })
    ).toThrow(/http\(s\)/);
    expect(
      () => new ArdenTtsClient({ endpoint: "file:///etc/passwd" })
    ).toThrow(/http\(s\)/);
  });

  it("rejects unparseable endpoint strings", () => {
    expect(
      () => new ArdenTtsClient({ endpoint: "not a url at all" })
    ).toThrow(/valid URL/);
  });

  it("preserves user-provided subpath in the endpoint", async () => {
    const subPathClient = new ArdenTtsClient({
      endpoint: "https://arden.example.com/api/v2",
    });
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 200,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      })
    );
    await subPathClient.synthesize("hi");
    expect(mockFetch.mock.calls[0]?.[0]).toBe(
      "https://arden.example.com/api/v2/synthesize"
    );
  });

  it("normalizes trailing slashes in the endpoint", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 200,
        arrayBuffer: () =>
          Promise.resolve(Uint8Array.from([1, 2, 3]).buffer),
      })
    );
    await client.synthesize("hello");
    expect(mockFetch.mock.calls[0]?.[0]).toBe(
      "https://arden.example.com/synthesize"
    );
  });

  it("synthesize POSTs JSON body with defaults", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 200,
        arrayBuffer: () =>
          Promise.resolve(Uint8Array.from([0xff, 0xfb]).buffer),
      })
    );

    const buf = await client.synthesize("안녕하세요");
    const call = mockFetch.mock.calls[0];
    const init = call?.[1] as {
      method: string;
      headers: Record<string, string>;
      body: string;
    };
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
    const payload = JSON.parse(init.body) as {
      text: string;
      voice: string;
      speed: number;
      locale: string;
    };
    expect(payload).toEqual({
      text: "안녕하세요",
      voice: "default",
      speed: 1.0,
      locale: "ko",
    });
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.length).toBe(2);
  });

  it("synthesize passes voice/speed/locale overrides", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 200,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      })
    );
    await client.synthesize("hi", {
      voice: "alto",
      speed: 1.25,
      locale: "en",
    });
    const body = JSON.parse(
      (mockFetch.mock.calls[0]?.[1] as { body: string }).body
    ) as { voice: string; speed: number; locale: string };
    expect(body).toMatchObject({
      voice: "alto",
      speed: 1.25,
      locale: "en",
    });
  });

  it("throws ExternalApiError on non-ok response", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        ok: false,
        status: 500,
        text: () => Promise.resolve("boom"),
      })
    );
    const caught = await client.synthesize("hi").catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(ExternalApiError);
    expect((caught as ExternalApiError).statusCode).toBe(500);
  });

  it("synthesizeBatch separates successes from failures and captures statusCode", async () => {
    mockFetch
      .mockResolvedValueOnce(
        mockResponse({
          ok: true,
          status: 200,
          arrayBuffer: () => Promise.resolve(Uint8Array.from([1]).buffer),
        })
      )
      .mockResolvedValueOnce(
        mockResponse({
          ok: false,
          status: 500,
          text: () => Promise.resolve("fail"),
        })
      )
      .mockResolvedValueOnce(
        mockResponse({
          ok: true,
          status: 200,
          arrayBuffer: () => Promise.resolve(Uint8Array.from([2, 3]).buffer),
        })
      );

    const result = await client.synthesizeBatch([
      { title: "first", script: "a" },
      { title: "broken", script: "b" },
      { title: "third", script: "c" },
    ]);

    expect(result.successes).toHaveLength(2);
    expect(result.failures).toHaveLength(1);
    expect(result.successes[0]?.title).toBe("first");
    expect(result.successes[1]?.title).toBe("third");
    expect(result.successes[0]?.audio.length).toBe(1);
    expect(result.successes[1]?.audio.length).toBe(2);
    expect(result.failures[0]?.title).toBe("broken");
    expect(result.failures[0]?.statusCode).toBe(500);
  });
});

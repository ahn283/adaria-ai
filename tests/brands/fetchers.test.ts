/* eslint-disable @typescript-eslint/require-await */
import { describe, expect, it, vi } from "vitest";

import { fetchWebData, __test__ } from "../../src/brands/fetchers/web.js";
import { fetchPackageData } from "../../src/brands/fetchers/package.js";
import { ExternalApiError, RateLimitError } from "../../src/utils/errors.js";

const { isPrivateOrReservedIp } = __test__;

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("isPrivateOrReservedIp", () => {
  it.each([
    "10.0.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "::",
    "fe80::1",
    "fc00::1",
    "fd12:3456::1",
    "ff00::1",
    "::ffff:127.0.0.1",
  ])("blocks %s", (ip) => {
    expect(isPrivateOrReservedIp(ip)).toBe(true);
  });

  it.each(["8.8.8.8", "1.1.1.1", "172.15.0.1", "172.32.0.1", "2001:db8::1"])(
    "allows %s",
    (ip) => {
      expect(isPrivateOrReservedIp(ip)).toBe(false);
    }
  );

  it("blocks unparseable input", () => {
    expect(isPrivateOrReservedIp("not-an-ip")).toBe(true);
  });
});

describe("fetchWebData", () => {
  const resolve = vi.fn(async () => ["8.8.8.8"]);

  it("extracts title, og, theme, and primary colour", async () => {
    const html = `<!doctype html><html><head>
      <title>Fridgify — Never waste food</title>
      <meta name="description" content="Simple fridge tracking">
      <meta property="og:title" content="Fridgify">
      <meta property="og:description" content="Track your fridge">
      <meta property="og:image" content="https://cdn.example.com/og.png">
      <meta name="theme-color" content="#22aa66">
      <style>:root { --primary-color: #22aa66; }</style>
    </head><body><p>hello world</p></body></html>`;
    const fetchImpl = vi.fn(async () => htmlResponse(html));
    const data = await fetchWebData("https://example.com", {
      resolve,
      fetch: fetchImpl as unknown as typeof fetch,
    });
    expect(data.title).toBe("Fridgify — Never waste food");
    expect(data.description).toBe("Simple fridge tracking");
    expect(data.ogTitle).toBe("Fridgify");
    expect(data.ogImage).toBe("https://cdn.example.com/og.png");
    expect(data.themeColor).toBe("#22aa66");
    expect(data.primaryColor).toBe("#22aa66");
    expect(data.bodyText).toContain("hello world");
  });

  it("blocks SSRF to private DNS-resolved host", async () => {
    const blockedResolve = vi.fn(async () => ["127.0.0.1"]);
    const fetchImpl = vi.fn();
    await expect(
      fetchWebData("https://evil.example.com", {
        resolve: blockedResolve,
        fetch: fetchImpl as unknown as typeof fetch,
      })
    ).rejects.toBeInstanceOf(ExternalApiError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("blocks SSRF to literal private IP", async () => {
    const fetchImpl = vi.fn();
    await expect(
      fetchWebData("http://192.168.1.1", {
        resolve,
        fetch: fetchImpl as unknown as typeof fetch,
      })
    ).rejects.toBeInstanceOf(ExternalApiError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects non-http schemes", async () => {
    await expect(
      fetchWebData("file:///etc/passwd", { resolve })
    ).rejects.toBeInstanceOf(ExternalApiError);
  });

  it("rejects non-HTML Content-Type", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("binary", {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      })
    );
    await expect(
      fetchWebData("https://example.com", {
        resolve,
        fetch: fetchImpl as unknown as typeof fetch,
      })
    ).rejects.toBeInstanceOf(ExternalApiError);
  });

  it("rejects over-sized declared body via content-length", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("<html/>", {
        status: 200,
        headers: {
          "content-type": "text/html",
          "content-length": String(10 * 1024 * 1024),
        },
      })
    );
    await expect(
      fetchWebData("https://example.com", {
        resolve,
        fetch: fetchImpl as unknown as typeof fetch,
      })
    ).rejects.toBeInstanceOf(ExternalApiError);
  });

  it("surfaces non-2xx responses", async () => {
    const fetchImpl = vi.fn(async () => htmlResponse("err", 500));
    await expect(
      fetchWebData("https://example.com", {
        resolve,
        fetch: fetchImpl as unknown as typeof fetch,
      })
    ).rejects.toBeInstanceOf(ExternalApiError);
  });
});

describe("fetchPackageData", () => {
  it("labels readmeSource as 'npm' when inlined in registry", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        name: "foo",
        readme: "# readme",
        "dist-tags": { latest: "1.0.0" },
      })
    );
    const data = await fetchPackageData("foo", undefined, {
      fetch: fetchImpl as unknown as typeof fetch,
    });
    expect(data.readmeSource).toBe("npm");
  });

  it("labels readmeSource as 'github' when fetched from GitHub", async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.includes("registry")) {
        return jsonResponse({
          name: "bar",
          repository: { url: "https://github.com/acme/bar" },
          "dist-tags": { latest: "1.0.0" },
        });
      }
      return jsonResponse({
        content: Buffer.from("# bar").toString("base64"),
        encoding: "base64",
      });
    });
    const data = await fetchPackageData("bar", undefined, {
      fetch: fetchImpl as unknown as typeof fetch,
    });
    expect(data.readmeSource).toBe("github");
  });

  it("labels readmeSource as null when no readme is available", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ name: "baz", "dist-tags": { latest: "1.0.0" } })
    );
    const data = await fetchPackageData("baz", undefined, {
      fetch: fetchImpl as unknown as typeof fetch,
    });
    expect(data.readmeSource).toBeNull();
  });

  it("returns npm metadata and inlined readme", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        name: "@eodin/analytics-sdk",
        description: "Eodin analytics SDK",
        homepage: "https://eodin.app",
        keywords: ["analytics", "sdk"],
        readme: "# Eodin SDK\n\nUsage details.",
        repository: { url: "https://github.com/eodin/analytics-sdk.git" },
        "dist-tags": { latest: "1.2.3" },
      })
    );
    const data = await fetchPackageData("@eodin/analytics-sdk", undefined, {
      fetch: fetchImpl as unknown as typeof fetch,
    });
    expect(data.name).toBe("@eodin/analytics-sdk");
    expect(data.version).toBe("1.2.3");
    expect(data.keywords).toEqual(["analytics", "sdk"]);
    expect(data.readme).toContain("Eodin SDK");
    expect(data.repositoryUrl).toContain("analytics-sdk.git");
  });

  it("falls back to GitHub README when npm omits it", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL) => {
      calls.push(typeof url === "string" ? url : url.toString());
      if (calls.length === 1) {
        return jsonResponse({
          name: "foo",
          repository: { url: "https://github.com/acme/foo" },
          "dist-tags": { latest: "1.0.0" },
        });
      }
      return jsonResponse({
        content: Buffer.from("# foo readme").toString("base64"),
        encoding: "base64",
      });
    });
    const data = await fetchPackageData("foo", undefined, {
      fetch: fetchImpl as unknown as typeof fetch,
    });
    expect(data.readme).toBe("# foo readme");
    expect(calls[1]).toContain("/repos/acme/foo/readme");
  });

  it("accepts an explicit githubRepo override", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL) => {
      calls.push(typeof url === "string" ? url : url.toString());
      if (calls.length === 1) {
        return jsonResponse({
          name: "bar",
          "dist-tags": { latest: "0.1.0" },
        });
      }
      return jsonResponse({
        content: Buffer.from("readme body").toString("base64"),
        encoding: "base64",
      });
    });
    await fetchPackageData("bar", "eodin/bar", {
      fetch: fetchImpl as unknown as typeof fetch,
    });
    expect(calls[1]).toContain("/repos/eodin/bar/readme");
  });

  it("returns empty readme on GitHub 404", async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.includes("registry.npmjs.org")) {
        return jsonResponse({
          name: "ghost",
          repository: { url: "https://github.com/acme/ghost" },
          "dist-tags": { latest: "1.0.0" },
        });
      }
      return new Response("", { status: 404 });
    });
    const data = await fetchPackageData("ghost", undefined, {
      fetch: fetchImpl as unknown as typeof fetch,
    });
    expect(data.readme).toBe("");
  });

  it("surfaces GitHub rate limit as RateLimitError", async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.includes("registry.npmjs.org")) {
        return jsonResponse({
          name: "baz",
          repository: { url: "https://github.com/acme/baz" },
          "dist-tags": { latest: "1.0.0" },
        });
      }
      return new Response("forbidden", { status: 403 });
    });
    await expect(
      fetchPackageData("baz", undefined, {
        fetch: fetchImpl as unknown as typeof fetch,
      })
    ).rejects.toBeInstanceOf(RateLimitError);
  });

  it("surfaces npm 404 as ExternalApiError", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 404 }));
    await expect(
      fetchPackageData("nope", undefined, {
        fetch: fetchImpl as unknown as typeof fetch,
      })
    ).rejects.toBeInstanceOf(ExternalApiError);
  });
});

import dns from "node:dns/promises";
import type dnsSync from "node:dns";
import net from "node:net";

import * as cheerio from "cheerio";
import { Agent } from "undici";

import { ExternalApiError } from "../../utils/errors.js";

/**
 * Web page brand-signal fetcher used by `generateBrandProfile` for
 * `serviceType: "web"`. Pulls the landing page HTML, extracts the
 * obvious brand signals (title, description, og:*, theme colour, CSS
 * custom properties), and returns a flat object that downstream code
 * feeds into the Claude brand-generate prompt as sanitised input.
 *
 * SSRF: the URL is user-supplied (operator typing a service URL in
 * Slack). We resolve DNS ourselves and refuse to follow redirects —
 * the pre-flight A/AAAA lookup must not resolve to a private range.
 * `fetch` redirects follow server-issued Location headers which could
 * otherwise hop to metadata endpoints.
 */

export interface WebBrandData {
  url: string;
  title: string;
  description: string;
  ogTitle: string;
  ogDescription: string;
  ogImage: string;
  themeColor: string;
  primaryColor: string;
  bodyText: string;
}

const MAX_HTML_BYTES = 2 * 1024 * 1024; // 2 MB — landing pages are small
const FETCH_TIMEOUT_MS = 15_000;
const BODY_TEXT_LIMIT = 4000;
const USER_AGENT = "adaria-ai/brand-profile";

export interface WebFetcherDeps {
  /** Override for tests — resolves the hostname to a list of IPs. */
  resolve?: (hostname: string) => Promise<string[]>;
  /** Override for tests — injected fetch. */
  fetch?: typeof fetch;
}

function isPrivateOrReservedIp(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 0) return true; // unresolvable/garbage → fail closed
  if (family === 4) {
    const parts = ip.split(".").map(Number);
    const [a, b] = parts;
    if (a === undefined || b === undefined) return true;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a >= 224) return true; // multicast + reserved
    return false;
  }
  // IPv6: block loopback, link-local, unique-local, multicast, unspecified.
  const lower = ip.toLowerCase();
  if (lower === "::" || lower === "::1") return true;
  if (lower.startsWith("fe80:") || lower.startsWith("fe80::")) return true;
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true;
  if (lower.startsWith("ff")) return true; // multicast
  // IPv4-mapped ::ffff:a.b.c.d → extract and re-check.
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped?.[1]) return isPrivateOrReservedIp(mapped[1]);
  return false;
}

async function resolvePublicAddress(
  hostname: string,
  resolve: (h: string) => Promise<string[]>
): Promise<string> {
  if (net.isIP(hostname)) {
    if (isPrivateOrReservedIp(hostname)) {
      throw new ExternalApiError(
        `Refusing to fetch private/reserved IP: ${hostname}`
      );
    }
    return hostname;
  }

  let addrs: string[];
  try {
    addrs = await resolve(hostname);
  } catch (cause) {
    throw new ExternalApiError(
      `DNS resolution failed for ${hostname}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause }
    );
  }

  if (addrs.length === 0) {
    throw new ExternalApiError(`DNS returned no records for ${hostname}`);
  }

  for (const ip of addrs) {
    if (isPrivateOrReservedIp(ip)) {
      throw new ExternalApiError(
        `Refusing to fetch private/reserved host ${hostname} (${ip})`
      );
    }
  }

  // Return first public IP — the fetch dispatcher pins this address to
  // close the DNS TOCTOU gap between pre-flight lookup and socket connect.
  const first = addrs[0];
  if (first === undefined) {
    throw new ExternalApiError(`DNS returned no records for ${hostname}`);
  }
  return first;
}

function makePinnedDispatcher(pinnedAddress: string): Agent {
  const family = net.isIP(pinnedAddress) === 6 ? 6 : 4;
  const lookup: typeof dnsSync.lookup = ((
    _hostname: string,
    optsOrCb: dnsSync.LookupOptions | ((...args: unknown[]) => void),
    maybeCb?: (...args: unknown[]) => void
  ): void => {
    const cb =
      typeof optsOrCb === "function"
        ? optsOrCb
        : (maybeCb as (...args: unknown[]) => void);
    const opts = typeof optsOrCb === "function" ? {} : optsOrCb;
    if (opts.all === true) {
      cb(null, [{ address: pinnedAddress, family }]);
      return;
    }
    cb(null, pinnedAddress, family);
  }) as unknown as typeof dnsSync.lookup;
  return new Agent({ connect: { lookup } });
}

async function defaultResolve(hostname: string): Promise<string[]> {
  const [v4, v6] = await Promise.allSettled([
    dns.resolve4(hostname),
    dns.resolve6(hostname),
  ]);
  const out: string[] = [];
  if (v4.status === "fulfilled") out.push(...v4.value);
  if (v6.status === "fulfilled") out.push(...v6.value);
  return out;
}

function extractPrimaryColor($: cheerio.CheerioAPI): string {
  // Inline <style> blocks only — external stylesheets are out of scope
  // for v1 (would require second fetch + CSS AST).
  const styles = $("style").text();
  const match = styles.match(/--[a-zA-Z-]*(?:primary|brand|accent)[^:]*:\s*([^;}\n]+)/i);
  return match?.[1]?.trim() ?? "";
}

/** Fetch landing page and extract brand signals. SSRF-guarded. */
export async function fetchWebData(
  rawUrl: string,
  deps: WebFetcherDeps = {}
): Promise<WebBrandData> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new ExternalApiError(`Invalid URL: ${rawUrl}`);
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new ExternalApiError(
      `Unsupported URL scheme ${parsed.protocol} — only http/https allowed`
    );
  }

  const resolver = deps.resolve ?? defaultResolve;
  const pinnedAddress = await resolvePublicAddress(parsed.hostname, resolver);

  const fetchImpl = deps.fetch ?? fetch;
  // Only pin the DNS when using the real fetch — tests inject their
  // own fetch and the dispatcher option would be ignored anyway.
  const dispatcher =
    deps.fetch === undefined ? makePinnedDispatcher(pinnedAddress) : undefined;

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, FETCH_TIMEOUT_MS);

  let response: Response;
  try {
    const init: Record<string, unknown> = {
      redirect: "error",
      signal: controller.signal,
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
      },
    };
    if (dispatcher !== undefined) init["dispatcher"] = dispatcher;
    response = await fetchImpl(parsed.toString(), init as RequestInit);
  } catch (cause) {
    throw new ExternalApiError(
      `Failed to fetch ${parsed.toString()}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause }
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new ExternalApiError(
      `HTTP ${String(response.status)} from ${parsed.toString()}`,
      { statusCode: response.status }
    );
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!/text\/html|application\/xhtml/.test(contentType)) {
    throw new ExternalApiError(
      `Unexpected Content-Type ${contentType} from ${parsed.toString()}`
    );
  }

  // Pre-flight size check from header before consuming the body.
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_HTML_BYTES) {
    throw new ExternalApiError(
      `HTML too large (declared ${String(declared)} bytes) from ${parsed.toString()}`
    );
  }

  const buf = Buffer.from(await response.arrayBuffer());
  if (buf.length > MAX_HTML_BYTES) {
    throw new ExternalApiError(
      `HTML too large (${String(buf.length)} bytes) from ${parsed.toString()}`
    );
  }

  const html = buf.toString("utf-8");
  const $ = cheerio.load(html);

  const bodyText = $("body").text().replace(/\s+/g, " ").trim().slice(
    0,
    BODY_TEXT_LIMIT
  );

  return {
    url: parsed.toString(),
    title: $("title").first().text().trim(),
    description: $('meta[name="description"]').attr("content")?.trim() ?? "",
    ogTitle: $('meta[property="og:title"]').attr("content")?.trim() ?? "",
    ogDescription:
      $('meta[property="og:description"]').attr("content")?.trim() ?? "",
    ogImage: $('meta[property="og:image"]').attr("content")?.trim() ?? "",
    themeColor: $('meta[name="theme-color"]').attr("content")?.trim() ?? "",
    primaryColor: extractPrimaryColor($),
    bodyText,
  };
}

export const __test__ = { isPrivateOrReservedIp };

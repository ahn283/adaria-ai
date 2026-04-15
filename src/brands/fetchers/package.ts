import { ExternalApiError, RateLimitError } from "../../utils/errors.js";

/**
 * npm + GitHub brand-signal fetcher for `serviceType: "package"`.
 *
 * npm Registry is fully public and unauthenticated. GitHub READMEs
 * come from the public contents API (60 req/hr per IP, unauth). On
 * 403/429 we surface a rate-limit error and let the caller abort the
 * flow cleanly (per PRD §10 decision 2).
 */

export interface PackageBrandData {
  name: string;
  version: string;
  description: string;
  homepage: string;
  repositoryUrl: string;
  keywords: string[];
  readme: string;
  /** Where `readme` came from. `null` when no readme was found. */
  readmeSource: "npm" | "github" | null;
}

const NPM_REGISTRY = "https://registry.npmjs.org";
const GITHUB_API = "https://api.github.com";
const FETCH_TIMEOUT_MS = 15_000;
const README_LIMIT = 20_000;
const USER_AGENT = "adaria-ai/brand-profile";

export interface PackageFetcherDeps {
  fetch?: typeof fetch;
}

interface NpmRegistryResponse {
  name?: string;
  description?: string;
  homepage?: string;
  keywords?: string[];
  readme?: string;
  repository?: { url?: string } | string;
  "dist-tags"?: { latest?: string };
}

interface GitHubContentsResponse {
  content?: string;
  encoding?: string;
}

function parseRepositoryUrl(
  repo: NpmRegistryResponse["repository"]
): string {
  if (!repo) return "";
  if (typeof repo === "string") return repo;
  return repo.url ?? "";
}

function deriveGithubRepo(repositoryUrl: string): string | null {
  const m = repositoryUrl.match(
    /github\.com[/:]([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?(?:[/?#]|$)/
  );
  if (!m?.[1] || !m[2]) return null;
  return `${m[1]}/${m[2]}`;
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init?: RequestInit
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, FETCH_TIMEOUT_MS);
  try {
    return await fetchImpl(url, {
      redirect: "error",
      ...init,
      signal: controller.signal,
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json",
        ...(init?.headers ?? {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchGithubReadme(
  fetchImpl: typeof fetch,
  repo: string
): Promise<string> {
  const url = `${GITHUB_API}/repos/${repo}/readme`;
  const response = await fetchWithTimeout(fetchImpl, url, {
    headers: { Accept: "application/vnd.github+json" },
  });

  if (response.status === 404) return "";
  if (response.status === 403 || response.status === 429) {
    throw new RateLimitError(
      "GitHub API rate limit hit — wait an hour and re-run `@adaria-ai brand`",
      { retryAfterSeconds: 3600 }
    );
  }
  if (!response.ok) {
    throw new ExternalApiError(
      `GitHub API ${String(response.status)} for ${repo}`,
      { statusCode: response.status }
    );
  }

  const data = (await response.json()) as GitHubContentsResponse;
  if (data.encoding !== "base64" || typeof data.content !== "string") {
    return "";
  }
  const decoded = Buffer.from(data.content, "base64").toString("utf-8");
  return decoded.slice(0, README_LIMIT);
}

/** Fetch npm package metadata and (optionally) the GitHub README. */
export async function fetchPackageData(
  npmName: string,
  githubRepo?: string,
  deps: PackageFetcherDeps = {}
): Promise<PackageBrandData> {
  if (!npmName.trim()) {
    throw new ExternalApiError("npm package name is required");
  }

  const fetchImpl = deps.fetch ?? fetch;

  // npm names may contain @scope/name — encodeURIComponent preserves it.
  const registryUrl = `${NPM_REGISTRY}/${encodeURIComponent(npmName).replace("%40", "@")}`;
  const response = await fetchWithTimeout(fetchImpl, registryUrl);

  if (response.status === 404) {
    throw new ExternalApiError(`npm package not found: ${npmName}`, {
      statusCode: 404,
    });
  }
  if (!response.ok) {
    throw new ExternalApiError(
      `npm registry ${String(response.status)} for ${npmName}`,
      { statusCode: response.status }
    );
  }

  const data = (await response.json()) as NpmRegistryResponse;
  const repositoryUrl = parseRepositoryUrl(data.repository);
  const resolvedRepo = githubRepo ?? deriveGithubRepo(repositoryUrl);

  let readme = data.readme ?? "";
  let readmeSource: PackageBrandData["readmeSource"] = readme ? "npm" : null;
  if (!readme && resolvedRepo !== null && resolvedRepo !== undefined) {
    readme = await fetchGithubReadme(fetchImpl, resolvedRepo);
    if (readme) readmeSource = "github";
  }

  return {
    name: data.name ?? npmName,
    version: data["dist-tags"]?.latest ?? "",
    description: data.description ?? "",
    homepage: data.homepage ?? "",
    repositoryUrl,
    keywords: Array.isArray(data.keywords) ? data.keywords : [],
    readme: readme.slice(0, README_LIMIT),
    readmeSource,
  };
}

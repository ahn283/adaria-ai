export interface RetryOptions {
  /** Maximum number of attempts (default: 3) */
  maxAttempts?: number;
  /** Base delay in ms (default: 1000) */
  baseDelay?: number;
  /** Maximum delay in ms (default: 30000) */
  maxDelay?: number;
  /** Whether to add jitter (default: true) */
  jitter?: boolean;
  /** Optional predicate to determine if the error is retryable */
  isRetryable?: (error: unknown) => boolean;
}

const DEFAULT_OPTIONS: Required<RetryOptions> = {
  maxAttempts: 3,
  baseDelay: 1000,
  maxDelay: 30_000,
  jitter: true,
  isRetryable: () => true,
};

/**
 * Executes a function with retry logic using exponential backoff.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: RetryOptions
): Promise<T> {
  const opts: Required<RetryOptions> = { ...DEFAULT_OPTIONS, ...options };
  let lastError: unknown;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt >= opts.maxAttempts || !opts.isRetryable(error)) {
        throw error;
      }

      const delay = calculateDelay(
        attempt,
        opts.baseDelay,
        opts.maxDelay,
        opts.jitter
      );
      await sleep(delay);
    }
  }

  throw lastError;
}

function calculateDelay(
  attempt: number,
  baseDelay: number,
  maxDelay: number,
  jitter: boolean
): number {
  let delay = baseDelay * Math.pow(2, attempt - 1);
  delay = Math.min(delay, maxDelay);
  if (jitter) {
    delay = Math.random() * delay;
  }
  return delay;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parse an HTTP `Retry-After` header value into seconds.
 *
 * RFC 7231 allows both a delta-seconds integer ("120") and an HTTP-date
 * ("Fri, 31 Dec 2026 23:59:59 GMT"). The growth-agent JS collectors only
 * handled the former; here we handle both and fall back to the caller's
 * default on anything unparseable or negative.
 */
export function parseRetryAfter(
  header: string | null | undefined,
  fallbackSeconds = 60
): number {
  if (!header) return fallbackSeconds;

  const asSeconds = Number(header);
  if (Number.isFinite(asSeconds)) {
    return asSeconds >= 0 ? asSeconds : fallbackSeconds;
  }

  const asDateMs = Date.parse(header);
  if (Number.isFinite(asDateMs)) {
    return Math.max(0, Math.ceil((asDateMs - Date.now()) / 1000));
  }

  return fallbackSeconds;
}

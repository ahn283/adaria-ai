/**
 * Unified error hierarchy for adaria-ai.
 * Each error carries a machine-readable code and a user-friendly message.
 */

interface ErrorCtorOptions {
  code?: string;
  userMessage?: string;
  cause?: unknown;
}

function buildErrorOptions(cause: unknown): ErrorOptions {
  return cause !== undefined ? { cause } : {};
}

export class AdariaError extends Error {
  readonly code: string;
  readonly userMessage: string;

  constructor(message: string, options?: ErrorCtorOptions) {
    super(message, buildErrorOptions(options?.cause));
    this.name = "AdariaError";
    this.code = options?.code ?? "ADARIA_ERROR";
    this.userMessage = options?.userMessage ?? message;
  }
}

function withDefaults(
  options: ErrorCtorOptions | undefined,
  defaultCode: string,
  defaultUserMessage: string
): ErrorCtorOptions {
  return {
    code: options?.code ?? defaultCode,
    userMessage: options?.userMessage ?? defaultUserMessage,
    ...(options?.cause !== undefined ? { cause: options.cause } : {}),
  };
}

export class AuthError extends AdariaError {
  constructor(message: string, options?: ErrorCtorOptions) {
    super(
      message,
      withDefaults(
        options,
        "AUTH_ERROR",
        "Authentication failed. Please check your credentials."
      )
    );
    this.name = "AuthError";
  }
}

export class ToolError extends AdariaError {
  constructor(message: string, options?: ErrorCtorOptions) {
    super(
      message,
      withDefaults(
        options,
        "TOOL_ERROR",
        "A tool operation failed. Please try again."
      )
    );
    this.name = "ToolError";
  }
}

export class ConfigError extends AdariaError {
  constructor(message: string, options?: ErrorCtorOptions) {
    super(
      message,
      withDefaults(
        options,
        "CONFIG_ERROR",
        'Configuration error. Run "adaria-ai init" to fix.'
      )
    );
    this.name = "ConfigError";
  }
}

export interface ExternalApiErrorOptions extends ErrorCtorOptions {
  statusCode?: number;
}

export class ExternalApiError extends AdariaError {
  readonly statusCode: number | undefined;

  constructor(message: string, options?: ExternalApiErrorOptions) {
    super(
      message,
      withDefaults(
        options,
        "EXTERNAL_API_ERROR",
        "An external service is temporarily unavailable."
      )
    );
    this.name = "ExternalApiError";
    this.statusCode = options?.statusCode;
  }
}

export interface RateLimitErrorOptions extends ErrorCtorOptions {
  retryAfterSeconds?: number;
}

export class RateLimitError extends AdariaError {
  readonly retryAfterSeconds: number;

  constructor(message: string, options?: RateLimitErrorOptions) {
    super(
      message,
      withDefaults(
        options,
        "RATE_LIMIT_ERROR",
        "Upstream service rate limited us. Retrying shortly."
      )
    );
    this.name = "RateLimitError";
    this.retryAfterSeconds = options?.retryAfterSeconds ?? 60;
  }
}

export class TimeoutError extends AdariaError {
  constructor(message: string, options?: ErrorCtorOptions) {
    super(
      message,
      withDefaults(
        options,
        "TIMEOUT_ERROR",
        "The operation timed out. Please try again."
      )
    );
    this.name = "TimeoutError";
  }
}

/** Returns a user-friendly message for any error. */
export function getUserMessage(error: unknown): string {
  if (error instanceof AdariaError) {
    return error.userMessage;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

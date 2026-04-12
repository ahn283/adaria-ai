import { ExternalApiError } from "../utils/errors.js";
import { error as logError } from "../utils/logger.js";

/**
 * Arden TTS API client.
 *
 * Converts short-form scripts to voiceover MP3 buffers. This is an
 * **internal** service owned by the same operator that runs adaria-ai,
 * so unlike the external collectors (App Store / Play Store / ASOMobile)
 * the endpoint is fully config-driven — there is no public production
 * hostname to allowlist. Trust derives from config ownership, not from
 * a baked-in allowlist. `config.yaml` is the source of truth.
 *
 * Cost: $0 (Eodin's own TTS service; cross-promotion effect).
 */
export interface ArdenTtsClientOptions {
  /** Base endpoint URL from `config.yaml` (trusted source). */
  endpoint: string;
}

export interface SynthesizeOptions {
  /** Voice identifier. Defaults to `default`. */
  voice?: string;
  /** Playback speed multiplier. Defaults to 1.0. */
  speed?: number;
  /** BCP-47 locale tag. Defaults to `ko`. */
  locale?: string;
}

export interface SynthesizeScript {
  title: string;
  script: string;
}

export interface SynthesizeResult {
  title: string;
  audio: Buffer;
}

export interface SynthesizeFailure {
  title: string;
  error: string;
  statusCode?: number;
}

export interface SynthesizeBatchResult {
  successes: SynthesizeResult[];
  failures: SynthesizeFailure[];
}

export class ArdenTtsClient {
  private readonly endpoint: string;

  constructor(options: ArdenTtsClientOptions) {
    if (!options.endpoint) {
      throw new Error("ArdenTtsClient requires endpoint");
    }
    // Arden TTS is user-hosted so we cannot pin a host allowlist (see
    // the file header). Enforce at least the scheme + parseability
    // contract so mis-typed config.yaml values fail loudly at
    // construction instead of deep inside undici with an opaque
    // TypeError. javascript:, file:, etc. all get rejected here.
    let parsed: URL;
    try {
      parsed = new URL(options.endpoint.trim());
    } catch {
      throw new Error(
        `ArdenTtsClient endpoint must be a valid URL, got: ${options.endpoint}`
      );
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(
        `ArdenTtsClient endpoint must use http(s), got: ${parsed.protocol}`
      );
    }
    // Trim trailing slashes on the base URL only. A user-provided
    // subpath (e.g. `/api/v2`) is preserved intact — `synthesize` appends
    // `/synthesize` to whatever path the caller configured.
    this.endpoint = parsed.toString().replace(/\/+$/, "");
  }

  /**
   * Generate voiceover audio from a script.
   *
   * @returns an MP3 audio buffer.
   */
  async synthesize(
    text: string,
    options: SynthesizeOptions = {}
  ): Promise<Buffer> {
    const response = await fetch(`${this.endpoint}/synthesize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        voice: options.voice ?? "default",
        speed: options.speed ?? 1.0,
        locale: options.locale ?? "ko",
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new ExternalApiError(
        `Arden TTS API ${String(response.status)}: ${body.slice(0, 512)}`,
        { statusCode: response.status }
      );
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  /**
   * Generate voiceovers for multiple scripts sequentially. Per-script
   * failures are logged with the structured status code (so
   * `ShortFormSkill` can tell a 429 from a 500) and collected in the
   * `failures` array; the overall call never rejects, so one bad script
   * cannot take down a whole short-form batch.
   */
  async synthesizeBatch(
    scripts: SynthesizeScript[],
    options: SynthesizeOptions = {}
  ): Promise<SynthesizeBatchResult> {
    const successes: SynthesizeResult[] = [];
    const failures: SynthesizeFailure[] = [];

    for (const { title, script } of scripts) {
      try {
        const audio = await this.synthesize(script, options);
        successes.push({ title, audio });
      } catch (err) {
        const statusCode =
          err instanceof ExternalApiError ? err.statusCode : undefined;
        const message = err instanceof Error ? err.message : String(err);
        const failure: SynthesizeFailure = { title, error: message };
        if (statusCode !== undefined) failure.statusCode = statusCode;
        failures.push(failure);
        logError(`[arden-tts] Failed to synthesize "${title}"`, {
          statusCode,
          error: message,
        });
      }
    }

    return { successes, failures };
  }
}

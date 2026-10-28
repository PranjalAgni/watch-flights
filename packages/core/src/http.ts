import { type Clock, sleep } from "./clock.js";

export type HttpErrorKind =
  "timeout" | "network" | "status" | "rate-limited" | "aborted";

export class HttpError extends Error {
  constructor(
    message: string,
    readonly kind: HttpErrorKind,
    readonly status?: number,
    readonly retryAfterMs?: number
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/** Shared per-provider cooldown, set when the provider answers 429. */
export class RateGate {
  blockedUntilMs = 0;
}

export interface HttpClientOptions {
  clock: Clock;
  fetch?: typeof fetch;
  userAgent?: string;
  /** Aborts every request made by this client (used on shutdown). */
  signal?: AbortSignal;
  baseBackoffMs?: number;
}

export interface RequestOptions {
  timeoutMs: number;
  retries: number;
  /**
   * Statuses returned to the caller instead of being treated as failures.
   * Defaults to [200].
   */
  acceptStatuses?: readonly number[];
  headers?: Record<string, string>;
  gate?: RateGate;
  /** Longest a request will wait for a rate-limit cooldown before failing. */
  maxRateLimitWaitMs?: number;
}

export interface HttpResponse {
  status: number;
  headers: Headers;
  body: Uint8Array;
}

const RETRYABLE_STATUSES = new Set([500, 502, 503, 504]);
/**
 * Floor for 429 waits, so "Retry-After: 0" never replays a request instantly.
 */
const MIN_RATE_LIMIT_WAIT_MS = 1_000;

export class HttpClient {
  readonly #clock: Clock;
  readonly #fetch: typeof fetch;
  readonly #userAgent: string;
  readonly #signal: AbortSignal | undefined;
  readonly #baseBackoffMs: number;

  constructor(options: HttpClientOptions) {
    this.#clock = options.clock;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#userAgent = options.userAgent ?? "nearby-flights";
    this.#signal = options.signal;
    this.#baseBackoffMs = options.baseBackoffMs ?? 1000;
  }

  async get(url: string, options: RequestOptions): Promise<HttpResponse> {
    const accept = options.acceptStatuses ?? [200];
    const maxWait = options.maxRateLimitWaitMs ?? 30_000;
    let lastError: HttpError | undefined;

    for (let attempt = 0; attempt <= options.retries; attempt++) {
      const hasRetry = attempt < options.retries;
      if (options.gate) await this.#waitForGate(options.gate, maxWait);

      let response: HttpResponse;
      try {
        response = await this.#attempt(url, options);
      } catch (error) {
        if (!(error instanceof HttpError) || error.kind === "aborted")
          throw error;
        lastError = error;
        if (hasRetry)
          await sleep(this.#clock, this.#backoff(attempt), this.#signal);
        continue;
      }

      if (accept.includes(response.status)) return response;

      if (response.status === 429) {
        const waitMs = Math.max(
          MIN_RATE_LIMIT_WAIT_MS,
          parseRetryAfter(
            response.headers.get("retry-after"),
            this.#clock.now()
          ) ?? this.#backoff(attempt)
        );
        if (options.gate)
          options.gate.blockedUntilMs = Math.max(
            options.gate.blockedUntilMs,
            this.#clock.now() + waitMs
          );
        lastError = new HttpError(
          "rate limited (HTTP 429)",
          "rate-limited",
          429,
          waitMs
        );
        if (!hasRetry || waitMs > maxWait) throw lastError;
        if (!options.gate) await sleep(this.#clock, waitMs, this.#signal);
        continue;
      }

      lastError = new HttpError(
        `HTTP ${response.status}`,
        "status",
        response.status
      );
      if (!RETRYABLE_STATUSES.has(response.status)) throw lastError;
      if (hasRetry)
        await sleep(this.#clock, this.#backoff(attempt), this.#signal);
    }
    throw lastError ?? new HttpError("request failed", "network");
  }

  #backoff(attempt: number): number {
    return this.#baseBackoffMs * 2 ** attempt;
  }

  async #waitForGate(gate: RateGate, maxWaitMs: number): Promise<void> {
    // Loop: another request may extend the cooldown while this one sleeps.
    for (
      let waitMs = gate.blockedUntilMs - this.#clock.now();
      waitMs > 0;
      waitMs = gate.blockedUntilMs - this.#clock.now()
    ) {
      if (waitMs > maxWaitMs)
        throw new HttpError(
          "rate limited (HTTP 429)",
          "rate-limited",
          429,
          waitMs
        );
      await sleep(this.#clock, waitMs, this.#signal);
    }
  }

  async #attempt(url: string, options: RequestOptions): Promise<HttpResponse> {
    if (this.#signal?.aborted) throw new HttpError("aborted", "aborted");
    const controller = new AbortController();
    let timedOut = false;
    const onOuterAbort = () => controller.abort();
    this.#signal?.addEventListener("abort", onOuterAbort, { once: true });
    const timer = this.#clock.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, options.timeoutMs);

    try {
      const res = await this.#fetch(url, {
        signal: controller.signal,
        headers: { "user-agent": this.#userAgent, ...options.headers }
      });
      const body = new Uint8Array(await res.arrayBuffer());
      return { status: res.status, headers: res.headers, body };
    } catch (error) {
      if (timedOut)
        throw new HttpError(
          `timed out after ${formatSeconds(options.timeoutMs)}`,
          "timeout"
        );
      if (this.#signal?.aborted) throw new HttpError("aborted", "aborted");
      throw new HttpError(
        `network error (${networkErrorDetail(error)})`,
        "network"
      );
    } finally {
      this.#clock.clearTimeout(timer);
      this.#signal?.removeEventListener("abort", onOuterAbort);
    }
  }
}

export function parseRetryAfter(
  value: string | null,
  nowMs: number
): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.ceil(Number(trimmed) * 1000);
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? undefined : Math.max(0, date - nowMs);
}

function formatSeconds(ms: number): string {
  return `${Math.round(ms / 100) / 10}s`;
}

function networkErrorDetail(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause as
      { code?: unknown; message?: unknown } | undefined;
    if (typeof cause?.code === "string") return cause.code;
    if (typeof cause?.message === "string" && cause.message)
      return cause.message;
    return error.message;
  }
  return String(error);
}

/** Human-readable one-line description of a failure, without stack traces. */
export function describeError(error: unknown): string {
  if (error instanceof HttpError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

const utf8 = new TextDecoder("utf-8");

export function decodeUtf8(bytes: Uint8Array): string {
  return utf8.decode(bytes);
}

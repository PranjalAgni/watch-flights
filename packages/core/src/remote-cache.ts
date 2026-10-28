import type { Clock } from "./clock.js";
import type { Limiter } from "./limit.js";

type Entry<V> =
  | { kind: "hit"; value: V; expiresAtMs: number }
  | { kind: "miss"; expiresAtMs: number }
  | { kind: "error"; expiresAtMs: number };

export interface RemoteCacheOptions {
  clock: Clock;
  /** Shared with other caches that call the same provider. */
  limit: Limiter;
  hitTtlMs: number;
  missTtlMs: number;
  /** Back-off after a failed lookup before asking again. */
  errorRetryMs: number;
}

/**
 * Caches a remote lookup by key: hits, misses and errors each expire on their
 * own schedule, concurrent requests for one key share a single lookup, and an
 * expired hit keeps being served (for up to one more TTL) while the provider
 * fails.
 */
export class RemoteCache<V> {
  readonly #entries = new Map<string, Entry<V>>();
  readonly #inFlight = new Map<string, Promise<void>>();

  constructor(
    private readonly lookup: (key: string) => Promise<V | null>,
    private readonly options: RemoteCacheOptions
  ) {}

  get(key: string): V | null {
    const entry = this.#entries.get(key);
    return entry?.kind === "hit" ? entry.value : null;
  }

  /** Looks up keys that are not cached or in flight. Never rejects. */
  async ensure(keys: Iterable<string>): Promise<void> {
    const now = this.options.clock.now();
    for (const [key, entry] of this.#entries) {
      const graceMs = entry.kind === "hit" ? this.options.hitTtlMs : 0;
      if (entry.expiresAtMs + graceMs <= now) this.#entries.delete(key);
    }
    const pending: Promise<void>[] = [];
    for (const key of new Set(keys)) {
      const cached = this.#entries.get(key);
      if (cached && cached.expiresAtMs > now) continue;
      let lookup = this.#inFlight.get(key);
      if (!lookup) {
        lookup = this.options
          .limit(() => this.#fetch(key))
          .finally(() => this.#inFlight.delete(key));
        this.#inFlight.set(key, lookup);
      }
      pending.push(lookup);
    }
    await Promise.all(pending);
  }

  async #fetch(key: string): Promise<void> {
    const { clock, hitTtlMs, missTtlMs, errorRetryMs } = this.options;
    try {
      const value = await this.lookup(key);
      const now = clock.now();
      this.#entries.set(
        key,
        value === null
          ? { kind: "miss", expiresAtMs: now + missTtlMs }
          : { kind: "hit", value, expiresAtMs: now + hitTtlMs }
      );
    } catch {
      const previous = this.#entries.get(key);
      const expiresAtMs = clock.now() + errorRetryMs;
      this.#entries.set(
        key,
        previous?.kind === "hit"
          ? { ...previous, expiresAtMs }
          : { kind: "error", expiresAtMs }
      );
    }
  }
}

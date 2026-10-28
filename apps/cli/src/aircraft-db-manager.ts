import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { gunzip as gunzipCallback } from "node:zlib";
import {
  AircraftDb,
  type Clock,
  describeError,
  type HttpClient,
  parseAircraftCsv
} from "@watch-flights/core";

const gunzip = promisify(gunzipCallback);

export const TAR1090_DB_URL =
  "https://raw.githubusercontent.com/wiedehopf/tar1090-db/csv/aircraft.csv.gz";
const DAY_MS = 24 * 60 * 60 * 1000;

export type AircraftDbState = "loading" | "ready" | "unavailable";

export interface AircraftDbStatus {
  state: AircraftDbState;
  records: number;
  updatedAtMs: number | null;
  refreshing: boolean;
  lastError: string | null;
  /** Set when the live copy is fine but could not be written to disk. */
  cacheError: string | null;
}

interface CacheMeta {
  fetchedAtMs: number;
  etag: string | null;
  lastModified: string | null;
}

export interface AircraftDbManagerOptions {
  http: HttpClient;
  clock: Clock;
  cacheDir: string;
  url?: string;
  maxAgeMs?: number;
  minRows?: number;
  onChange?: () => void;
}

export class AircraftDbManager {
  #db = AircraftDb.empty;
  #state: AircraftDbState = "loading";
  #meta: CacheMeta | null = null;
  #refreshing: Promise<void> | null = null;
  #lastError: string | null = null;
  #cacheError: string | null = null;
  readonly #options: Required<Omit<AircraftDbManagerOptions, "onChange">> &
    Pick<AircraftDbManagerOptions, "onChange">;

  constructor(options: AircraftDbManagerOptions) {
    this.#options = {
      url: TAR1090_DB_URL,
      maxAgeMs: 7 * DAY_MS,
      minRows: 100_000,
      ...options
    };
  }

  get db(): AircraftDb {
    return this.#db;
  }

  status(): AircraftDbStatus {
    return {
      state: this.#state,
      records: this.#db.size,
      updatedAtMs: this.#meta?.fetchedAtMs ?? null,
      refreshing: this.#refreshing !== null,
      lastError: this.#lastError,
      cacheError: this.#cacheError
    };
  }

  /**
   * Loads the cached copy; downloads only when there is no usable cache,
   * otherwise refreshes in the background.
   */
  async init(): Promise<void> {
    try {
      const [gz, metaText] = await Promise.all([
        readFile(this.#dataPath),
        readFile(this.#metaPath, "utf8")
      ]);
      const meta = parseMeta(metaText);
      this.#db = parseAircraftCsv(
        (await gunzip(gz)).toString("utf8"),
        this.#options.minRows
      );
      this.#meta = meta;
      this.#state = "ready";
      this.#notify();
    } catch {
      // No usable cache: fall through to a blocking download.
    }
    if (this.#state === "ready") {
      this.refreshIfStale();
      return;
    }
    await this.refresh();
  }

  refreshIfStale(): void {
    const meta = this.#meta;
    if (
      meta &&
      this.#options.clock.now() - meta.fetchedAtMs < this.#options.maxAgeMs
    )
      return;
    void this.refresh();
  }

  refresh(): Promise<void> {
    this.#refreshing ??= this.#download().finally(() => {
      this.#refreshing = null;
      this.#notify();
    });
    this.#notify();
    return this.#refreshing;
  }

  async #download(): Promise<void> {
    const { http, clock, url, minRows } = this.#options;
    const conditional: Record<string, string> = {};
    if (this.#state === "ready" && this.#meta?.etag)
      conditional["if-none-match"] = this.#meta.etag;
    if (this.#state === "ready" && this.#meta?.lastModified)
      conditional["if-modified-since"] = this.#meta.lastModified;
    try {
      const response = await http.get(url, {
        timeoutMs: 120_000,
        retries: 1,
        acceptStatuses: [200, 304],
        headers: conditional
      });
      if (response.status === 304 && this.#meta) {
        this.#meta = { ...this.#meta, fetchedAtMs: clock.now() };
        this.#lastError = null;
        await this.#save(() => this.#writeMeta(this.#meta!));
      } else {
        const db = parseAircraftCsv(
          (await gunzip(response.body)).toString("utf8"),
          minRows
        );
        this.#db = db;
        this.#state = "ready";
        this.#meta = {
          fetchedAtMs: clock.now(),
          etag: response.headers.get("etag"),
          lastModified: response.headers.get("last-modified")
        };
        this.#lastError = null;
        const meta = this.#meta;
        await this.#save(() => this.#writeCache(response.body, meta));
      }
    } catch (error) {
      this.#lastError = describeError(error);
      if (this.#state === "loading") this.#state = "unavailable";
    }
  }

  /**
   * Persists the cache; a failure here leaves the in-memory copy live and is
   * reported separately.
   */
  async #save(write: () => Promise<void>): Promise<void> {
    try {
      await write();
      this.#cacheError = null;
    } catch (error) {
      this.#cacheError = describeError(error);
    }
  }

  get #dataPath() {
    return join(this.#options.cacheDir, "aircraft.csv.gz");
  }

  get #metaPath() {
    return join(this.#options.cacheDir, "aircraft.meta.json");
  }

  async #writeCache(gz: Uint8Array, meta: CacheMeta): Promise<void> {
    await mkdir(this.#options.cacheDir, { recursive: true });
    await writeAtomic(this.#dataPath, gz);
    await this.#writeMeta(meta);
  }

  async #writeMeta(meta: CacheMeta): Promise<void> {
    await mkdir(this.#options.cacheDir, { recursive: true });
    await writeAtomic(this.#metaPath, JSON.stringify(meta, null, 2));
  }

  #notify() {
    this.#options.onChange?.();
  }
}

async function writeAtomic(
  path: string,
  data: string | Uint8Array
): Promise<void> {
  const temp = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temp, data);
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

function parseMeta(text: string): CacheMeta {
  const raw = JSON.parse(text) as Partial<CacheMeta>;
  if (typeof raw.fetchedAtMs !== "number")
    throw new Error("invalid cache metadata");
  return {
    fetchedAtMs: raw.fetchedAtMs,
    etag: typeof raw.etag === "string" ? raw.etag : null,
    lastModified: typeof raw.lastModified === "string" ? raw.lastModified : null
  };
}

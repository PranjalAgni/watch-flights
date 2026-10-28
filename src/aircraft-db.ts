import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { gunzip as gunzipCallback } from "node:zlib";
import type { Clock } from "./clock.js";
import { describeError, type HttpClient } from "./http.js";

const gunzip = promisify(gunzipCallback);

export const TAR1090_DB_URL =
  "https://raw.githubusercontent.com/wiedehopf/tar1090-db/csv/aircraft.csv.gz";
const DAY_MS = 24 * 60 * 60 * 1000;

export interface AircraftDbRecord {
  registration: string | null;
  typeCode: string | null;
  description: string | null;
  ownerOperator: string | null;
}

export class AircraftDbSchemaError extends Error {
  constructor(detail: string) {
    super(`aircraft database failed validation (${detail})`);
    this.name = "AircraftDbSchemaError";
  }
}

/**
 * tar1090-db rows: `icao;registration;type;dbFlags;description;year;ownOp;`.
 * Rows are kept as raw strings keyed by lowercase hex and parsed on lookup to
 * keep memory low.
 */
export class AircraftDb {
  static readonly empty = new AircraftDb(new Map());

  constructor(private readonly rows: ReadonlyMap<string, string>) {}

  get size(): number {
    return this.rows.size;
  }

  lookup(hex: string): AircraftDbRecord | null {
    const row = this.rows.get(hex.toLowerCase());
    if (row === undefined) return null;
    const [registration, typeCode, , description, , ownOp] = row.split(";");
    return {
      registration: field(registration),
      typeCode: field(typeCode),
      description: field(description),
      ownerOperator: cleanOwnerOperator(ownOp)
    };
  }
}

const HEX_PATTERN = /^[0-9a-fA-F]{6}$/;

export function parseAircraftCsv(text: string, minRows = 1): AircraftDb {
  const rows = new Map<string, string>();
  let malformed = 0;
  let total = 0;
  let start = 0;
  while (start < text.length) {
    let end = text.indexOf("\n", start);
    if (end === -1) end = text.length;
    const line =
      text.charCodeAt(end - 1) === 13
        ? text.slice(start, end - 1)
        : text.slice(start, end);
    start = end + 1;
    if (line === "") continue;
    total++;
    const separator = line.indexOf(";");
    const hex = line.slice(0, separator);
    const rest = line.slice(separator + 1);
    if (
      separator !== 6 ||
      !HEX_PATTERN.test(hex) ||
      countSemicolons(rest) < 6
    ) {
      malformed++;
      continue;
    }
    rows.set(hex.toLowerCase(), rest);
  }
  if (total === 0) throw new AircraftDbSchemaError("no rows");
  if (malformed / total > 0.01)
    throw new AircraftDbSchemaError(`${malformed} of ${total} rows malformed`);
  if (rows.size < minRows)
    throw new AircraftDbSchemaError(
      `only ${rows.size} rows, expected at least ${minRows}`
    );
  return new AircraftDb(rows);
}

function countSemicolons(value: string): number {
  let count = 0;
  for (let i = value.indexOf(";"); i !== -1; i = value.indexOf(";", i + 1))
    count++;
  return count;
}

function field(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Drops tar1090-db annotations such as "(Miscode - VARIOUS)" and "(Hex also
 * used by ...)".
 */
export function cleanOwnerOperator(value: string | undefined): string | null {
  const cleaned = value
    ?.replace(/\((?:Miscode|Hex also used)[^)]*\)/gi, "")
    .replace(/^\s*Miscode\b.*$/i, "")
    .trim();
  return cleaned ? cleaned : null;
}

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

  async #writeCache(gz: Buffer, meta: CacheMeta): Promise<void> {
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

async function writeAtomic(path: string, data: string | Buffer): Promise<void> {
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

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { gzipSync } from "node:zlib";
import {
  AircraftDbManager,
  AircraftDbSchemaError,
  cleanOwnerOperator,
  parseAircraftCsv
} from "../src/aircraft-db.js";
import { HttpClient } from "../src/http.js";
import { FakeClock } from "./helpers/fake-clock.js";
import { fakeFetch, type Handler, readFixture } from "./helpers/fake-fetch.js";

const SAMPLE = readFixture("aircraft-sample.csv");
const DAY = 24 * 60 * 60 * 1000;

describe("parseAircraftCsv", () => {
  const db = parseAircraftCsv(SAMPLE);

  it("resolves registration, type and model for every aircraft in adsb.json", () => {
    for (const hex of [
      "800c88",
      "80184e",
      "800733",
      "8018c7",
      "8014ec",
      "8016c9",
      "50801b",
      "8018ca",
      "801928"
    ]) {
      const record = db.lookup(hex);
      assert.ok(
        record?.registration && record.typeCode && record.description,
        hex
      );
    }
    assert.deepEqual(db.lookup("800C88"), {
      registration: "VT-CIP",
      typeCode: "A20N",
      description: "AIRBUS A-320neo",
      ownerOperator: null
    });
    assert.equal(
      db.lookup("801928")?.registration,
      "VT-NOU",
      "fills the registration the feed omitted"
    );
  });

  it("returns null for unknown hexes", () => {
    assert.equal(db.lookup("abcdef"), null);
  });

  it("strips tar1090-db annotations from owner/operator", () => {
    assert.equal(db.lookup("007cc1")?.ownerOperator, "ARKANSAS BOLT CO");
    assert.equal(db.lookup("0088bb")?.ownerOperator, null);
    assert.equal(db.lookup("000001")?.ownerOperator, null);
    assert.equal(
      cleanOwnerOperator("Government of Egypt"),
      "Government of Egypt"
    );
  });

  it("validates the schema", () => {
    assert.throws(() => parseAircraftCsv(""), AircraftDbSchemaError);
    assert.throws(
      () => parseAircraftCsv("icao,reg,type\n800c88,VT-CIP,A20N\n"),
      /rows malformed/
    );
    assert.throws(() => parseAircraftCsv(SAMPLE, 1_000), /only 12 rows/);
  });

  it("tolerates CRLF line endings", () => {
    assert.equal(
      parseAircraftCsv(SAMPLE.replaceAll("\n", "\r\n")).lookup("800c88")
        ?.ownerOperator,
      null
    );
  });
});

async function setup(handler: Handler) {
  const clock = new FakeClock();
  const cacheDir = await mkdtemp(join(tmpdir(), "nf-db-"));
  const { fetch, calls } = fakeFetch(handler);
  const manager = new AircraftDbManager({
    http: new HttpClient({ clock, fetch, baseBackoffMs: 0 }),
    clock,
    cacheDir,
    url: "https://db.test/aircraft.csv.gz",
    minRows: 1
  });
  return { clock, cacheDir, calls, manager };
}

const gz = (text: string) => gzipSync(Buffer.from(text));

async function seedCache(cacheDir: string, fetchedAtMs: number, text = SAMPLE) {
  await writeFile(join(cacheDir, "aircraft.csv.gz"), gz(text));
  await writeFile(
    join(cacheDir, "aircraft.meta.json"),
    JSON.stringify({ fetchedAtMs, etag: '"v1"', lastModified: null })
  );
}

describe("AircraftDbManager", () => {
  it("downloads and caches the database when there is no cache", async () => {
    const { cacheDir, calls, manager } = await setup(
      () => new Response(gz(SAMPLE), { headers: { etag: '"v2"' } })
    );
    await manager.init();
    assert.equal(calls.length, 1);
    assert.equal(manager.status().state, "ready");
    assert.equal(manager.db.lookup("800c88")?.registration, "VT-CIP");
    const meta = JSON.parse(
      await readFile(join(cacheDir, "aircraft.meta.json"), "utf8")
    );
    assert.equal(meta.etag, '"v2"');
  });

  it("uses a fresh cache without any network request", async () => {
    const { clock, cacheDir, calls, manager } = await setup(() =>
      assert.fail("no request expected")
    );
    await seedCache(cacheDir, clock.now() - DAY);
    await manager.init();
    assert.equal(calls.length, 0);
    assert.equal(manager.db.size, 12);
  });

  it("revalidates a stale cache with a conditional request", async () => {
    const { clock, cacheDir, calls, manager } = await setup(
      () => new Response(null, { status: 304 })
    );
    await seedCache(cacheDir, clock.now() - 8 * DAY);
    await manager.init();
    await manager.refresh();
    assert.equal(calls[0]!.headers["if-none-match"], '"v1"');
    assert.equal(manager.status().updatedAtMs, clock.now());
    assert.equal(manager.status().lastError, null);
  });

  it("keeps the last usable copy when a refresh fails", async () => {
    const { clock, cacheDir, manager } = await setup(
      () => new Response("", { status: 500 })
    );
    await seedCache(cacheDir, clock.now() - 8 * DAY);
    await manager.init();
    await manager.refresh();
    assert.equal(manager.status().state, "ready");
    assert.equal(manager.status().lastError, "HTTP 500");
    assert.equal(manager.db.lookup("800c88")?.registration, "VT-CIP");
  });

  it("rejects a download that fails schema validation and keeps the old copy", async () => {
    const { clock, cacheDir, manager } = await setup(
      () => new Response(gz("not;a;database\n"))
    );
    await seedCache(cacheDir, clock.now() - 8 * DAY);
    await manager.init();
    await manager.refresh();
    assert.match(manager.status().lastError!, /failed validation/);
    assert.equal(manager.db.size, 12);
    const cached = await readFile(join(cacheDir, "aircraft.csv.gz"));
    assert.deepEqual(cached, gz(SAMPLE), "the cached file is not overwritten");
  });

  it("keeps a good download live when it cannot be saved to disk", async () => {
    const clock = new FakeClock();
    const parent = await mkdtemp(join(tmpdir(), "nf-db-"));
    const cacheDir = join(parent, "blocked");
    await writeFile(cacheDir, "a file where the cache directory should be");
    const { fetch } = fakeFetch(() => new Response(gz(SAMPLE)));
    const manager = new AircraftDbManager({
      http: new HttpClient({ clock, fetch }),
      clock,
      cacheDir,
      url: "https://db.test/a.csv.gz",
      minRows: 1
    });
    await manager.init();
    const status = manager.status();
    assert.equal(status.state, "ready");
    assert.equal(status.lastError, null, "the refresh itself succeeded");
    assert.ok(status.cacheError, "the save failure is reported separately");
    assert.equal(manager.db.lookup("800c88")?.registration, "VT-CIP");
  });

  it("removes its temporary file when the final rename fails", async () => {
    const { cacheDir, manager } = await setup(() => new Response(gz(SAMPLE)));
    // rename onto a directory fails
    await mkdir(join(cacheDir, "aircraft.csv.gz"));
    await manager.init();
    assert.ok(manager.status().cacheError);
    assert.deepEqual(
      (await readdir(cacheDir)).filter((f) => f.endsWith(".tmp")),
      []
    );
  });

  it("reports unavailable when there is no cache and the download fails", async () => {
    const { manager } = await setup(() => {
      throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
    });
    await manager.init();
    assert.equal(manager.status().state, "unavailable");
    assert.equal(manager.status().lastError, "network error (ECONNREFUSED)");
    assert.equal(manager.db.lookup("800c88"), null);
  });

  it("does not start overlapping refreshes", async () => {
    const { calls, manager } = await setup(() => new Response(gz(SAMPLE)));
    await Promise.all([
      manager.refresh(),
      manager.refresh(),
      manager.refresh()
    ]);
    assert.equal(calls.length, 1);
  });
});

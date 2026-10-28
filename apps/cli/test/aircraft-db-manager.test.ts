import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { gzipSync } from "node:zlib";
import { HttpClient } from "@watch-flights/core";
import {
  FakeClock,
  fakeFetch,
  type Handler,
  readFixture
} from "@watch-flights/core/testing";
import { AircraftDbManager } from "../src/aircraft-db-manager.js";

const SAMPLE = readFixture("aircraft-sample.csv");
const DAY = 24 * 60 * 60 * 1000;

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

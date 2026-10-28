import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type FlightRoute,
  formatDirection,
  type Location,
  type LocationState,
  MetadataService,
  normalizeSnapshot,
  parseAdsbdbCallsignResponse,
  parseAdsbLolResponse,
  parseAircraftCsv,
  type Snapshot
} from "@watch-flights/core";
import {
  FakeClock,
  readFixture,
  readJsonFixture
} from "@watch-flights/core/testing";
import type { AircraftDbStatus } from "../src/aircraft-db-manager.js";
import {
  renderFrame,
  type RenderInput,
  type RenderOptions
} from "../src/display/render.js";
import {
  shouldUseColor,
  stripAnsi,
  visibleLength
} from "../src/display/style.js";

const RGIA: Location = {
  id: "rgia",
  name: "RGIA, Hyderabad",
  latitude: 17.239943874504426,
  longitude: 78.42947104117285,
  radiusKm: 100,
  enabled: true
};
const LKO: Location = {
  id: "lucknow",
  name: "Chaudhary Charan Singh International Airport, Lucknow",
  latitude: 26.761944,
  longitude: 80.883333,
  radiusKm: 100,
  enabled: true
};

// 28 Oct 2026, 15:28:21 IST - one second after the fixture's server time.
const FETCHED_AT = 1793181501000;
const snapshot: Snapshot = normalizeSnapshot(
  parseAdsbLolResponse(readJsonFixture("adsb.json")),
  RGIA,
  FETCHED_AT
);
const db = parseAircraftCsv(readFixture("aircraft-sample.csv"));
const metadata = new MetadataService({
  clock: new FakeClock(),
  aircraftDb: () => db,
  remote: null
});
const DB_STATUS: AircraftDbStatus = {
  state: "ready",
  records: 623216,
  updatedAtMs: FETCHED_AT,
  refreshing: false,
  lastError: null,
  cacheError: null
};

function input(
  states: LocationState[],
  overrides: Partial<RenderInput> = {}
): RenderInput {
  return {
    nowMs: FETCHED_AT + 30_000,
    states,
    resolve: (a) => metadata.resolve(a),
    nextRefreshAtMs: FETCHED_AT + 300_000,
    pollIntervalMs: 300_000,
    aircraftDb: DB_STATUS,
    time: { timeZone: "Asia/Kolkata", label: "IST" },
    ...overrides
  };
}

const ok = (location: Location = RGIA): LocationState => ({
  location,
  lastSuccess: snapshot,
  lastError: null,
  fetching: false
});
const plain: RenderOptions = { width: 140, color: false, mode: "live" };
const render = (
  states: LocationState[],
  options: Partial<RenderOptions> = {},
  overrides: Partial<RenderInput> = {}
) => renderFrame(input(states, overrides), { ...plain, ...options });

describe("renderFrame", () => {
  it("shows a labelled section per location with radius, count, last success time in IST and status", () => {
    const frame = render([ok(), ok(LKO)]);
    assert.match(frame, /RGIA, Hyderabad\s+● OK/);
    assert.match(
      frame,
      /Chaudhary Charan Singh International Airport, Lucknow\s+● OK/
    );
    assert.match(
      frame,
      /100 km radius · 9 aircraft · last success 15:28:21 IST \(30s ago\)/
    );
    assert.match(frame, /Next refresh 15:33:21 IST · in 4:30/);
    assert.match(frame, /28 Oct 2026, 15:28:51 IST/);
  });

  it("lists aircraft nearest first with converted units and resolved metadata", () => {
    const rows = render([ok()])
      .split("\n")
      .filter((l) => /^ │ [A-Z]/.test(l) && !l.includes("Callsign"));
    assert.equal(rows.length, 9);
    assert.match(
      rows[0]!,
      /ADB716F\s+│ unknown │ UR-82007 │ ANTONOV An-124 Ruslan .*│\s+23\.3 km │ 116° SE │\s+6,200 ft │ 375 km\/h │ 016° N │\s+30s │/
    );
    assert.match(rows.at(-1)!, /AIC39F .* 84\.0 km/);
  });

  it('shows unavailable values as "unknown"', () => {
    const frame = render([ok()]);
    const row = frame.split("\n").find((l) => l.includes("IGO773F"))!;
    assert.match(row, /VT-NOU/, "registration comes from the local database");
    assert.match(
      row,
      /unknown/,
      "owner/operator is not available for this aircraft"
    );
  });

  it("never emits ANSI codes when colour is off, and uses them when on", () => {
    assert.equal(render([ok()]), stripAnsi(render([ok()])));
    assert.notEqual(
      render([ok()], { color: true }),
      stripAnsi(render([ok()], { color: true }))
    );
  });

  it("keeps the last snapshot and marks it stale after a failed fetch", () => {
    const frame = render(
      [
        {
          ...ok(),
          lastError: {
            atMs: FETCHED_AT + 300_000,
            message: "timed out after 10s"
          }
        }
      ],
      {},
      { nowMs: FETCHED_AT + 310_000 }
    );
    assert.match(frame, /▲ STALE/);
    assert.match(
      frame,
      /Fetch failed at 15:33:21 IST: timed out after 10s\. Showing the last successful snapshot\./
    );
    assert.match(
      frame,
      /9 aircraft · last success 15:28:21 IST \(5m 10s ago\)/
    );
    assert.match(frame, /ADB716F/);
  });

  it("does not report a failed first fetch as zero aircraft", () => {
    const frame = render([
      {
        location: LKO,
        lastSuccess: null,
        lastError: { atMs: FETCHED_AT, message: "HTTP 503" },
        fetching: false
      }
    ]);
    assert.match(frame, /✖ ERROR/);
    assert.match(frame, /aircraft count unknown · no successful fetch yet/);
    assert.match(
      frame,
      /Fetch failed at 15:28:21 IST: HTTP 503\. No aircraft data yet\./
    );
    assert.doesNotMatch(frame, /0 aircraft/);
  });

  it("describes an empty response as no returned aircraft rather than empty airspace", () => {
    const frame = render([
      { ...ok(), lastSuccess: { fetchedAtMs: FETCHED_AT, aircraft: [] } }
    ]);
    assert.match(frame, /0 aircraft/);
    assert.match(
      frame,
      /ADSB.lol returned no airborne aircraft within 100 km\./
    );
  });

  it("shows a fetching state before the first fetch completes", () => {
    const frame = render(
      [{ location: RGIA, lastSuccess: null, lastError: null, fetching: true }],
      {},
      { nextRefreshAtMs: null }
    );
    assert.match(frame, /◌ FETCHING/);
    assert.match(frame, /Fetching aircraft…/);
    assert.match(frame, /Refreshing now…/);
  });

  it("shows all columns when wide, including bearing and track separately", () => {
    const header = render([ok()])
      .split("\n")
      .find((l) => l.includes("Callsign"))!;
    for (const name of [
      "Callsign",
      "Route",
      "Reg",
      "Model",
      "Owner/Operator",
      "Dist",
      "Bearing",
      "Alt",
      "Speed",
      "Track",
      "Seen"
    ]) {
      assert.ok(header.includes(name), name);
    }
  });

  it("hides secondary columns first on narrower terminals", () => {
    const header = render([ok()], { width: 96 })
      .split("\n")
      .find((l) => l.includes("Callsign"))!;
    for (const name of [
      "Callsign",
      "Route",
      "Model",
      "Owner/Operator",
      "Dist",
      "Alt",
      "Speed"
    ])
      assert.ok(header.includes(name), name);
    for (const name of ["Track", "Seen", "Bearing"])
      assert.ok(!header.includes(name), name);
  });

  it("keeps every line at least one column narrower than the terminal", () => {
    const route = parseAdsbdbCallsignResponse(
      200,
      readJsonFixture("adsbdb-callsign-axb1520.json")
    )!;
    const resolve: RenderInput["resolve"] = (a) => ({
      ...metadata.resolve(a),
      route: {
        value: route,
        source: "adsbdb",
        verification: "reported",
        check: "inconsistent"
      }
    });
    const empty: LocationState = {
      ...ok(LKO),
      lastSuccess: { fetchedAtMs: FETCHED_AT, aircraft: [] }
    };
    const failed: LocationState = {
      location: LKO,
      lastSuccess: null,
      lastError: { atMs: FETCHED_AT, message: "network error (ENOTFOUND)" },
      fetching: false
    };
    for (const width of [40, 44, 52, 60, 64, 72, 80, 96, 120, 160]) {
      for (const maxAircraftPerLocation of [undefined, 2]) {
        const frame = render(
          [ok(), empty, failed],
          { width, color: true, maxAircraftPerLocation },
          { resolve }
        );
        for (const line of frame.split("\n")) {
          assert.ok(
            visibleLength(line) < width,
            `width ${width}: ${visibleLength(line)} >= ${width}: ${stripAnsi(line)}`
          );
        }
      }
    }
  });

  it("lines up columns across locations", () => {
    const borders = render([ok(), ok(LKO)])
      .split("\n")
      .filter((l) => l.startsWith(" ┌"));
    assert.equal(borders.length, 2);
    assert.equal(borders[0], borders[1]);
  });

  it("caps rows per location when asked and says how many are hidden", () => {
    const frame = render([ok()], { maxAircraftPerLocation: 3 });
    assert.match(frame, /\+ 6 more aircraft farther away/);
    assert.doesNotMatch(frame, /AIC39F/);
  });

  it("prints a non-interactive footer without countdown or key hints", () => {
    const log = render([ok()], { mode: "log" });
    assert.match(log, /Next refresh 15:33:21 IST\n/);
    assert.doesNotMatch(log, /Ctrl-C/);
    assert.match(
      render([ok()], { mode: "once" }),
      /Single snapshot \(--once\)/
    );
  });

  it("explains a missing aircraft database", () => {
    const frame = render(
      [ok()],
      {},
      {
        aircraftDb: {
          state: "unavailable",
          records: 0,
          updatedAtMs: null,
          refreshing: false,
          lastError: "HTTP 404",
          cacheError: null
        }
      }
    );
    assert.match(frame, /Aircraft DB: unavailable \(HTTP 404\)/);
  });
});

describe("formatting", () => {
  it("shows routes by airport code and flags ones that do not match the position", async () => {
    const routes: Record<string, FlightRoute> = {
      IGO176: parseAdsbdbCallsignResponse(
        200,
        readJsonFixture("adsbdb-callsign-igo176.json")
      )!,
      AXB1520: parseAdsbdbCallsignResponse(
        200,
        readJsonFixture("adsbdb-callsign-axb1520.json")
      )!
    };
    const withRoutes = new MetadataService({
      clock: new FakeClock(),
      aircraftDb: () => db,
      remote: {
        lookupAircraft: async () => null,
        lookupRoute: async (callsign) => routes[callsign] ?? null
      }
    });
    await withRoutes.ensureRemote(snapshot.aircraft);
    const frame = render([ok()], {}, { resolve: (a) => withRoutes.resolve(a) });
    const row = (callsign: string) =>
      frame.split("\n").find((l) => l.includes(callsign))!;
    assert.match(row("IGO176"), /│ DEL→BLR\s+│/);
    assert.match(row("AXB1520"), /│ GAU→CCU\?\s+│/);
    assert.match(row("IGO773F"), /│ unknown\s+│/);
    assert.match(
      frame,
      /Routes: ADSBdb, published per callsign, not confirmed · \? = does not match the aircraft's position/
    );
    assert.doesNotMatch(
      render([ok()]),
      /\? = does not match/,
      "the legend only appears when a route is flagged"
    );
  });

  it("formats directions with zero-padded degrees and compass point", () => {
    assert.equal(formatDirection(3.5), "004° N");
    assert.equal(formatDirection(359.6), "000° N");
    assert.equal(formatDirection(313), "313° NW");
    assert.equal(formatDirection(null), "unknown");
  });
});

describe("shouldUseColor", () => {
  it("respects NO_COLOR, FORCE_COLOR, TTY and dumb terminals", () => {
    assert.equal(shouldUseColor({ isTTY: true }, {}), true);
    assert.equal(shouldUseColor({ isTTY: true }, { NO_COLOR: "1" }), false);
    assert.equal(shouldUseColor({ isTTY: false }, {}), false);
    assert.equal(shouldUseColor({ isTTY: false }, { FORCE_COLOR: "1" }), true);
    assert.equal(shouldUseColor({ isTTY: true }, { TERM: "dumb" }), false);
  });
});

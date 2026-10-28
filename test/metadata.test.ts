import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AircraftDb, parseAircraftCsv } from "../src/aircraft-db.js";
import { MetadataService } from "../src/metadata.js";
import { normalizeSnapshot } from "../src/normalize.js";
import {
  type AdsbdbAircraft,
  parseAdsbdbAircraftResponse,
  parseAdsbdbCallsignResponse
} from "../src/providers/adsbdb.js";
import { parseAdsbLolResponse } from "../src/providers/adsblol.js";
import type { AircraftPosition, FlightRoute, Location } from "../src/types.js";
import { FakeClock, flush } from "./helpers/fake-clock.js";
import { readFixture, readJsonFixture } from "./helpers/fake-fetch.js";

const RGIA: Location = {
  id: "rgia",
  name: "RGIA",
  latitude: 17.24,
  longitude: 78.43,
  radiusKm: 100,
  enabled: true
};
const db = parseAircraftCsv(readFixture("aircraft-sample.csv"));
const AIR_INDIA = parseAdsbdbAircraftResponse(
  200,
  readJsonFixture("adsbdb-800c88.json")
)!;
const aircraft = normalizeSnapshot(
  parseAdsbLolResponse(readJsonFixture("adsb.json")),
  RGIA,
  0
).aircraft;
const byHex = (hex: string) => aircraft.find((a) => a.hex === hex)!;
/** Fixture aircraft by hex; unknown hexes get a callsign-less stand-in. */
const at = (...hexes: string[]): AircraftPosition[] =>
  hexes.map(
    (hex) =>
      aircraft.find((a) => a.hex === hex) ?? {
        ...aircraft[0]!,
        hex,
        callsign: null
      }
  );
const IGO176 = parseAdsbdbCallsignResponse(
  200,
  readJsonFixture("adsbdb-callsign-igo176.json")
)!;
const AXB1520 = parseAdsbdbCallsignResponse(
  200,
  readJsonFixture("adsbdb-callsign-axb1520.json")
)!;
const ROUTES: Record<string, FlightRoute> = { IGO176, AXB1520 };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function setup(
  lookup: (hex: string) => Promise<AdsbdbAircraft | null>,
  aircraftDb: AircraftDb = db,
  lookupRoute: (callsign: string) => Promise<FlightRoute | null> = async (
    callsign
  ) => ROUTES[callsign] ?? null
) {
  const clock = new FakeClock();
  const calls: string[] = [];
  const routeCalls: string[] = [];
  const service = new MetadataService({
    clock,
    aircraftDb: () => aircraftDb,
    remote: {
      lookupAircraft: (hex) => {
        calls.push(hex);
        return lookup(hex);
      },
      lookupRoute: (callsign) => {
        routeCalls.push(callsign);
        return lookupRoute(callsign);
      }
    }
  });
  return { clock, calls, routeCalls, service };
}

describe("MetadataService.resolve", () => {
  it("resolves registration and model locally, recording source and corroboration", () => {
    const { service } = setup(async () => null);
    const meta = service.resolve(byHex("800c88"));
    assert.deepEqual(meta.registration, {
      value: "VT-CIP",
      source: "adsb.lol",
      verification: "corroborated"
    });
    assert.deepEqual(meta.model, {
      value: "AIRBUS A-320neo",
      source: "tar1090-db",
      verification: "reported"
    });
    assert.equal(meta.owner, null);
  });

  it("fills fields the feed omitted from the local database", () => {
    const { service } = setup(async () => null);
    const meta = service.resolve(byHex("801928"));
    assert.deepEqual(meta.registration, {
      value: "VT-NOU",
      source: "tar1090-db",
      verification: "reported"
    });
    assert.equal(meta.typeCode?.value, "A21N");
  });

  it("adds the ADSBdb registered owner once fetched, distinct from owner/operator labels", async () => {
    const { service } = setup(async () => AIR_INDIA);
    await service.ensureRemote(at("800c88"));
    const meta = service.resolve(byHex("800c88"));
    assert.deepEqual(meta.owner, {
      value: "Air India",
      source: "adsbdb",
      verification: "reported"
    });
    assert.equal(meta.ownerOperator, null);
  });

  it("uses remote model data when there is no local database", async () => {
    const { service } = setup(async () => AIR_INDIA, AircraftDb.empty);
    await service.ensureRemote(at("800c88"));
    assert.equal(
      service.resolve(byHex("800c88")).model?.value,
      "Airbus A320 251NSL"
    );
  });

  it("keeps position-specific values out of shared metadata", () => {
    const { service } = setup(async () => null);
    const fromRgia = byHex("800c88");
    const elsewhere: AircraftPosition = {
      ...fromRgia,
      distanceKm: 1,
      bearingDeg: 90
    };
    assert.deepEqual(service.resolve(fromRgia), service.resolve(elsewhere));
  });
});

describe("MetadataService.ensureRemote", () => {
  it("shares one in-flight lookup between locations seeing the same aircraft", async () => {
    const pending = deferred<AdsbdbAircraft | null>();
    const { calls, service } = setup(() => pending.promise);
    const rgia = service.ensureRemote(at("800c88"));
    const lucknow = service.ensureRemote(at("800c88", "800c88"));
    await flush();
    assert.deepEqual(calls, ["800c88"]);
    pending.resolve(AIR_INDIA);
    await Promise.all([rgia, lucknow]);
    assert.equal(service.resolve(byHex("800c88")).owner?.value, "Air India");
  });

  it("caches hits and misses so repeat polls make no requests", async () => {
    const { calls, service } = setup(async (hex) =>
      hex === "800c88" ? AIR_INDIA : null
    );
    await service.ensureRemote(at("800c88", "801928"));
    await service.ensureRemote(at("800c88", "801928"));
    assert.deepEqual(calls.sort(), ["800c88", "801928"]);
  });

  it("expires misses after their TTL", async () => {
    const { clock, calls, service } = setup(async () => null);
    await service.ensureRemote(at("801928"));
    await clock.advance(24 * 60 * 60 * 1000);
    await service.ensureRemote(at("801928"));
    assert.deepEqual(calls, ["801928", "801928"]);
  });

  it("backs off after errors and keeps an earlier hit", async () => {
    let fail = false;
    const { clock, calls, service } = setup(async () => {
      if (fail) throw new Error("down");
      return AIR_INDIA;
    });
    await service.ensureRemote(at("800c88"));
    await clock.advance(24 * 60 * 60 * 1000);
    fail = true;
    await service.ensureRemote(at("800c88"));
    assert.equal(service.resolve(byHex("800c88")).owner?.value, "Air India");
    await service.ensureRemote(at("800c88"));
    assert.equal(calls.length, 2, "no retry during the error back-off");
    await clock.advance(15 * 60 * 1000);
    await service.ensureRemote(at("800c88"));
    assert.equal(calls.length, 3);
  });

  it("bounds concurrency", async () => {
    let active = 0;
    let peak = 0;
    const gates: (() => void)[] = [];
    const { service } = setup(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => gates.push(resolve));
      active--;
      return null;
    });
    let settled = false;
    const done = service.ensureRemote(aircraft).then(() => (settled = true));
    while (!settled) {
      await flush();
      gates.shift()?.();
    }
    await done;
    assert.equal(peak, 2);
  });

  it("evicts expired entries but keeps a recent hit as a fallback", async () => {
    let fail = false;
    const { clock, calls, service } = setup(async (hex) => {
      if (fail) throw new Error("down");
      return hex === "800c88" ? AIR_INDIA : null;
    });
    await service.ensureRemote(at("800c88", "801928"));
    await clock.advance(24 * 60 * 60 * 1000);
    fail = true;
    await service.ensureRemote([]);
    assert.equal(
      service.resolve(byHex("800c88")).owner?.value,
      "Air India",
      "expired hit survives one grace TTL"
    );
    await clock.advance(24 * 60 * 60 * 1000);
    await service.ensureRemote([]);
    assert.equal(
      service.resolve(byHex("800c88")).owner,
      null,
      "evicted after the grace period"
    );
    assert.equal(calls.length, 2);
  });

  it("skips non-ICAO addresses", async () => {
    const { calls, service } = setup(async () => null);
    await service.ensureRemote(at("~abc123"));
    assert.deepEqual(calls, []);
  });
});

describe("MetadataService routes", () => {
  it("shows a published route that matches where the aircraft is", async () => {
    const { service } = setup(async () => null);
    await service.ensureRemote(at("8018c7"));
    const route = service.resolve(byHex("8018c7")).route;
    assert.equal(route?.value.origin.iata, "DEL");
    assert.equal(route?.value.destination.iata, "BLR");
    assert.equal(route?.source, "adsbdb");
    assert.equal(route?.check, "consistent", "DEL-BLR passes over Hyderabad");
  });

  it("flags a published route that does not match the position (reused callsign)", async () => {
    const { service } = setup(async () => null);
    await service.ensureRemote(at("8016c9"));
    const route = service.resolve(byHex("8016c9")).route;
    assert.equal(route?.value.origin.iata, "GAU");
    assert.equal(
      route?.check,
      "inconsistent",
      "Guwahati-Kolkata is nowhere near Hyderabad"
    );
  });

  it("marks a route unchecked when there is no position", async () => {
    const { service } = setup(async () => null);
    const noPosition = { ...byHex("8018c7"), latitude: null, longitude: null };
    await service.ensureRemote([noPosition]);
    assert.equal(service.resolve(noPosition).route?.check, "unchecked");
  });

  it("does not look up routes for registration callsigns or missing callsigns", async () => {
    const { routeCalls, service } = setup(async () => null);
    await service.ensureRemote([
      byHex("8014ec"),
      { ...byHex("8018c7"), callsign: null }
    ]);
    assert.deepEqual(
      routeCalls,
      [],
      "VTVIN is the registration VT-VIN: a private flight with no schedule"
    );
    assert.equal(service.resolve(byHex("8014ec")).route, null);
  });

  it("looks each callsign up once and caches misses", async () => {
    const { routeCalls, service } = setup(async () => null);
    await service.ensureRemote(aircraft);
    await service.ensureRemote(aircraft);
    assert.deepEqual(routeCalls.sort(), [
      "ADB716F",
      "AIC39F",
      "AIC4AT",
      "AXB1520",
      "IGO176",
      "IGO464W",
      "IGO5058",
      "IGO773F"
    ]);
  });

  it("re-checks routes after the route TTL, sooner than aircraft data", async () => {
    const { clock, calls, routeCalls, service } = setup(async () => null);
    await service.ensureRemote(at("8018c7"));
    await clock.advance(6 * 60 * 60 * 1000);
    await service.ensureRemote(at("8018c7"));
    assert.equal(calls.length, 1);
    assert.equal(routeCalls.length, 2);
  });

  it("keeps showing the last route while ADSBdb fails", async () => {
    let fail = false;
    const { clock, service } = setup(
      async () => null,
      db,
      async (callsign) => {
        if (fail) throw new Error("down");
        return ROUTES[callsign] ?? null;
      }
    );
    await service.ensureRemote(at("8018c7"));
    await clock.advance(6 * 60 * 60 * 1000);
    fail = true;
    await service.ensureRemote(at("8018c7"));
    assert.equal(
      service.resolve(byHex("8018c7")).route?.value.destination.iata,
      "BLR"
    );
  });
});

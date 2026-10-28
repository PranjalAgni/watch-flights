import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { distanceKm } from "../src/geo.js";
import { normalizeSnapshot } from "../src/normalize.js";
import { parseAdsbLolResponse, pointUrl } from "../src/providers/adsblol.js";
import { ProviderSchemaError } from "../src/providers/errors.js";
import type { Location } from "../src/types.js";
import { readJsonFixture } from "./helpers/fake-fetch.js";

const RGIA: Location = {
  id: "rgia",
  name: "RGIA, Hyderabad",
  latitude: 17.239943874504426,
  longitude: 78.42947104117285,
  radiusKm: 100,
  enabled: true
};

type RawFixture = { now: number; ac: Record<string, unknown>[] };
const fixture = () => readJsonFixture<RawFixture>("adsb.json");
const FETCHED_AT = 1793181501000;

function snapshotOf(raw: unknown) {
  return normalizeSnapshot(parseAdsbLolResponse(raw), RGIA, FETCHED_AT);
}

describe("normalize (adsb.json fixture)", () => {
  const snapshot = snapshotOf(fixture());

  it("keeps all 9 airborne aircraft, nearest first", () => {
    assert.equal(snapshot.aircraft.length, 9);
    const distances = snapshot.aircraft.map((a) => a.distanceKm!);
    assert.deepEqual(
      distances,
      [...distances].sort((a, b) => a - b)
    );
    assert.deepEqual(
      snapshot.aircraft.map((a) => a.hex),
      [
        "50801b",
        "8014ec",
        "8018ca",
        "8018c7",
        "801928",
        "80184e",
        "8016c9",
        "800733",
        "800c88"
      ]
    );
  });

  it("trims callsigns and converts nautical units", () => {
    const antonov = snapshot.aircraft[0]!;
    assert.equal(antonov.callsign, "ADB716F");
    assert.equal(antonov.distanceKm, 12.593 * 1.852);
    assert.equal(antonov.groundSpeedKmh, 202.6 * 1.852);
    assert.deepEqual(antonov.altitude, { kind: "airborne", feet: 6200 });
    assert.equal(antonov.bearingDeg, 116.0);
    assert.equal(antonov.feed.registration, "UR-82007");
    assert.equal(antonov.feed.typeCode, "A124");
  });

  it("keeps bearing-to-aircraft (dir) separate from direction of travel (track)", () => {
    const aic = snapshot.aircraft.find((a) => a.hex === "800c88")!;
    assert.equal(aic.bearingDeg, 313.0);
    assert.equal(aic.trackDeg, 3.5);
  });

  it('computes position time from the epoch-ms "now" minus seen_pos seconds', () => {
    const aic = snapshot.aircraft.find((a) => a.hex === "800c88")!;
    assert.equal(aic.positionAtMs, 1793181500500 - 276);
  });

  it("preserves missing values as null instead of inventing them", () => {
    const noReg = snapshot.aircraft.find((a) => a.hex === "801928")!;
    assert.equal(noReg.feed.registration, null);
    assert.equal(noReg.feed.typeCode, null);
    assert.equal(noReg.feed.description, null);
    assert.equal(noReg.feed.ownerOperator, null);
  });

  it("provider distances agree with great-circle distance from the location", () => {
    for (const aircraft of snapshot.aircraft) {
      const computed = distanceKm(
        RGIA.latitude,
        RGIA.longitude,
        aircraft.latitude!,
        aircraft.longitude!
      );
      assert.ok(
        Math.abs(computed - aircraft.distanceKm!) < 0.5,
        `${aircraft.hex}: ${computed} vs ${aircraft.distanceKm}`
      );
    }
  });
});

describe("normalize edge cases", () => {
  it("excludes aircraft explicitly reporting ground status", () => {
    const raw = fixture();
    raw.ac[0]!.alt_baro = "ground";
    const snapshot = snapshotOf(raw);
    assert.equal(snapshot.aircraft.length, 8);
    assert.ok(!snapshot.aircraft.some((a) => a.hex === "800c88"));
  });

  it("keeps aircraft with unknown altitude", () => {
    const raw = fixture();
    delete raw.ac[0]!.alt_baro;
    const aic = snapshotOf(raw).aircraft.find((a) => a.hex === "800c88")!;
    assert.equal(aic.altitude, null);
  });

  it("falls back to computed distance and bearing when the provider omits them", () => {
    const raw = fixture();
    const entry = raw.ac.find((a) => a.hex === "800c88")!;
    delete entry.dst;
    delete entry.dir;
    const aic = snapshotOf(raw).aircraft.find((a) => a.hex === "800c88")!;
    assert.ok(Math.abs(aic.distanceKm! - 45.343 * 1.852) < 0.5);
    assert.ok(Math.abs(aic.bearingDeg! - 313) < 1);
  });

  it("keys by hex: duplicates collapse to the freshest position", () => {
    const raw = fixture();
    raw.ac.push({
      ...raw.ac[0]!,
      hex: "800C88",
      seen_pos: 9,
      flight: "OLDER   "
    });
    const matches = snapshotOf(raw).aircraft.filter((a) => a.hex === "800c88");
    assert.equal(matches.length, 1);
    assert.equal(matches[0]!.callsign, "AIC39F");
  });

  it("drops records without a valid hex and ignores wrongly typed fields", () => {
    const raw = fixture();
    raw.ac.push({ hex: "nothex", lat: 17 }, { flight: "NOHEX" } as Record<
      string,
      unknown
    >);
    raw.ac[0]!.gs = "fast";
    const response = parseAdsbLolResponse(raw);
    assert.equal(response.rejected, 1);
    const snapshot = normalizeSnapshot(response, RGIA, FETCHED_AT);
    assert.equal(snapshot.aircraft.length, 9);
    assert.equal(
      snapshot.aircraft.find((a) => a.hex === "800c88")!.groundSpeedKmh,
      null
    );
  });

  it("treats an empty response as zero returned aircraft", () => {
    assert.deepEqual(snapshotOf({ now: 1793181500500, ac: [] }).aircraft, []);
  });

  it('accepts a "now" in seconds defensively', () => {
    const raw = fixture();
    raw.now = 1793181500.5;
    const aic = snapshotOf(raw).aircraft.find((a) => a.hex === "800c88")!;
    assert.equal(aic.positionAtMs, 1793181500500 - 276);
  });

  it("rejects responses that do not match the expected shape", () => {
    assert.throws(() => parseAdsbLolResponse(null), ProviderSchemaError);
    assert.throws(
      () => parseAdsbLolResponse({ now: 1, msg: "error" }),
      /missing "ac" list/
    );
    assert.throws(() => parseAdsbLolResponse({ ac: [] }), /missing "now"/);
  });
});

describe("ADSB.lol point URL", () => {
  it("converts the radius from kilometres to nautical miles", () => {
    assert.equal(
      pointUrl(RGIA),
      "https://api.adsb.lol/v2/point/17.239943874504426/78.42947104117285/53.996"
    );
  });
});

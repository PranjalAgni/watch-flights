import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AircraftDb } from "../src/aircraft-db.js";
import { HttpError } from "../src/http.js";
import { MetadataService } from "../src/metadata.js";
import { parseAdsbLolResponse } from "../src/providers/adsblol.js";
import type { Location } from "../src/types.js";
import { FlightWatcher } from "../src/watcher.js";
import { FakeClock } from "./helpers/fake-clock.js";
import { readJsonFixture } from "./helpers/fake-fetch.js";

const loc = (id: string, enabled = true): Location => ({
  id,
  name: id.toUpperCase(),
  latitude: 17.24,
  longitude: 78.43,
  radiusKm: 100,
  enabled
});

function setup(fetchPoint: (location: Location) => Promise<unknown>) {
  const clock = new FakeClock();
  const metadata = new MetadataService({
    clock,
    aircraftDb: () => AircraftDb.empty,
    remote: null
  });
  const watcher = new FlightWatcher({
    locations: [loc("rgia"), loc("lucknow"), loc("off", false)],
    positions: {
      fetchPoint: async (l) => parseAdsbLolResponse(await fetchPoint(l))
    },
    metadata,
    clock
  });
  const state = (id: string) =>
    watcher.states.find((s) => s.location.id === id)!;
  return { clock, watcher, state };
}

describe("FlightWatcher", () => {
  it("polls only enabled locations", () => {
    const { watcher } = setup(async () => readJsonFixture("adsb.json"));
    assert.deepEqual(
      watcher.states.map((s) => s.location.id),
      ["rgia", "lucknow"]
    );
  });

  it("a failure at one location does not block the other", async () => {
    const { watcher, state } = setup(async (l) => {
      if (l.id === "lucknow")
        throw new HttpError("timed out after 10s", "timeout");
      return readJsonFixture("adsb.json");
    });
    await watcher.runCycle();
    assert.equal(state("rgia").lastSuccess?.aircraft.length, 9);
    assert.equal(state("rgia").lastError, null);
    assert.equal(state("lucknow").lastSuccess, null);
    assert.equal(state("lucknow").lastError?.message, "timed out after 10s");
  });

  it("keeps the last successful snapshot after a failure, and clears the error on recovery", async () => {
    let fail = false;
    const { clock, watcher, state } = setup(async () => {
      if (fail) throw new HttpError("HTTP 503", "status", 503);
      return readJsonFixture("adsb.json");
    });
    await watcher.runCycle();
    const first = state("rgia").lastSuccess!;
    fail = true;
    await clock.advance(300_000);
    await watcher.runCycle();
    assert.equal(
      state("rgia").lastSuccess,
      first,
      "a failure is never reported as zero aircraft"
    );
    assert.deepEqual(state("rgia").lastError, {
      atMs: clock.now(),
      message: "HTTP 503"
    });
    fail = false;
    await watcher.runCycle();
    assert.equal(state("rgia").lastError, null);
    assert.notEqual(state("rgia").lastSuccess, first);
  });

  it("records an empty response as a successful snapshot with zero aircraft", async () => {
    const { watcher, state } = setup(async () => ({
      now: 1793181500500,
      ac: []
    }));
    await watcher.runCycle();
    assert.deepEqual(state("rgia").lastSuccess?.aircraft, []);
    assert.equal(state("rgia").lastError, null);
  });

  it("records schema problems as errors", async () => {
    const { watcher, state } = setup(async () => ({ msg: "oops" }));
    await watcher.runCycle();
    assert.match(
      state("rgia").lastError!.message,
      /unexpected response from ADSB.lol/
    );
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HttpClient } from "../src/http.js";
import {
  AdsbdbClient,
  parseAdsbdbAircraftResponse,
  parseAdsbdbCallsignResponse
} from "../src/providers/adsbdb.js";
import { FakeClock } from "./helpers/fake-clock.js";
import { fakeFetch, json, readJsonFixture } from "./helpers/fake-fetch.js";

describe("ADSBdb", () => {
  it("parses a known aircraft", () => {
    assert.deepEqual(
      parseAdsbdbAircraftResponse(200, readJsonFixture("adsbdb-800c88.json")),
      {
        registration: "VT-CIP",
        icaoType: "A20N",
        type: "A320 251NSL",
        manufacturer: "Airbus",
        registeredOwner: "Air India",
        ownerCountry: "India",
        ownerOperatorFlagCode: "AIC"
      }
    );
  });

  it('treats "unknown aircraft" and 404 as a miss, not an error', async () => {
    assert.equal(
      parseAdsbdbAircraftResponse(404, readJsonFixture("adsbdb-unknown.json")),
      null
    );
    const { fetch, calls } = fakeFetch(() =>
      json(readJsonFixture("adsbdb-unknown.json"), 404)
    );
    const client = new AdsbdbClient(
      new HttpClient({ clock: new FakeClock(), fetch })
    );
    assert.equal(await client.lookupAircraft("801928"), null);
    assert.equal(calls[0]!.url, "https://api.adsbdb.com/v0/aircraft/801928");
  });

  it("rejects malformed bodies", () => {
    assert.throws(
      () => parseAdsbdbAircraftResponse(200, { response: { nope: 1 } }),
      /unexpected response from ADSBdb/
    );
  });

  it("treats a 404 that is not an ADSBdb answer as an error, not a miss", async () => {
    assert.throws(
      () => parseAdsbdbAircraftResponse(404, { error: "not found" }),
      /unexpected response from ADSBdb/
    );
    const { fetch } = fakeFetch(
      () => new Response("<html>Not Found</html>", { status: 404 })
    );
    const client = new AdsbdbClient(
      new HttpClient({ clock: new FakeClock(), fetch })
    );
    await assert.rejects(client.lookupAircraft("801928"), /not JSON/);
  });

  it("parses a callsign route", async () => {
    const { fetch, calls } = fakeFetch(() =>
      json(readJsonFixture("adsbdb-callsign-igo176.json"))
    );
    const client = new AdsbdbClient(
      new HttpClient({ clock: new FakeClock(), fetch })
    );
    const route = await client.lookupRoute("IGO176");
    assert.equal(calls[0]!.url, "https://api.adsbdb.com/v0/callsign/IGO176");
    assert.equal(route?.callsign, "IGO176");
    assert.equal(route?.origin.iata, "DEL");
    assert.equal(route?.origin.icao, "VIDP");
    assert.equal(route?.origin.municipality, "New Delhi");
    assert.equal(route?.destination.icao, "VOBL");
    assert.equal(Math.round(route!.destination.latitude), 13);
  });

  it('treats "unknown callsign" as a miss and other 404s as errors', async () => {
    assert.equal(
      parseAdsbdbCallsignResponse(
        404,
        readJsonFixture("adsbdb-callsign-unknown.json")
      ),
      null
    );
    assert.throws(
      () => parseAdsbdbCallsignResponse(404, {}),
      /unexpected response from ADSBdb/
    );
  });

  it("rejects routes without usable airports", () => {
    const body = readJsonFixture("adsbdb-callsign-igo176.json") as {
      response: { flightroute: { origin: Record<string, unknown> } };
    };
    body.response.flightroute.origin.latitude = "north";
    assert.throws(
      () => parseAdsbdbCallsignResponse(200, body),
      /incomplete flightroute/
    );
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AircraftDbSchemaError,
  cleanOwnerOperator,
  parseAircraftCsv
} from "../src/aircraft-db.js";
import { readFixture } from "./helpers/fake-fetch.js";

const SAMPLE = readFixture("aircraft-sample.csv");

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

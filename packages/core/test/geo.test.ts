import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isOnRoute } from "../src/geo.js";

const at = (latitude: number, longitude: number) => ({ latitude, longitude });
const DEL = at(28.5665, 77.1031);
const BLR = at(13.1979, 77.7063);
const HYD = at(17.2313, 78.4299);
const CCU = at(22.6547, 88.4467);
const GAU = at(26.1061, 91.5859);

describe("isOnRoute", () => {
  it("accepts positions near either airport", () => {
    assert.equal(
      isOnRoute(at(17.5, 78.6), HYD, CCU),
      true,
      "just after departure"
    );
    assert.equal(isOnRoute(at(22.4, 88.0), HYD, CCU), true, "on approach");
  });

  it("accepts positions in the corridor between the airports", () => {
    assert.equal(
      isOnRoute(at(20.9, 77.4), DEL, BLR),
      true,
      "midway, on the great circle"
    );
    assert.equal(
      isOnRoute(at(17.0, 78.4), DEL, BLR),
      true,
      "~120 km off a 1,700 km route"
    );
    assert.equal(
      isOnRoute(at(17.0, 78.4), BLR, DEL),
      true,
      "direction does not matter"
    );
  });

  it("rejects positions far off the path", () => {
    assert.equal(
      isOnRoute(at(17.2, 78.4), GAU, CCU),
      false,
      "Hyderabad is not on Guwahati-Kolkata"
    );
    assert.equal(
      isOnRoute(at(20.9, 83.5), DEL, BLR),
      false,
      "~650 km east of the path"
    );
  });

  it("rejects positions beyond either end of the route", () => {
    assert.equal(isOnRoute(at(10.0, 77.9), DEL, BLR), false, "past Bangalore");
    assert.equal(isOnRoute(at(31.5, 76.6), DEL, BLR), false, "behind Delhi");
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConfigError, parseConfig } from "../src/config.js";

const location = (overrides: Record<string, unknown> = {}) => ({
  id: "rgia",
  name: "RGIA, Hyderabad",
  latitude: 17.24,
  longitude: 78.43,
  radiusKm: 100,
  enabled: true,
  ...overrides
});

function problemsOf(raw: unknown): readonly string[] {
  try {
    parseConfig(raw);
  } catch (error) {
    assert.ok(error instanceof ConfigError);
    return error.problems;
  }
  assert.fail("expected a ConfigError");
}

describe("config", () => {
  it("accepts disabled locations as long as one is enabled", () => {
    const config = parseConfig({
      locations: [location(), location({ id: "other", enabled: false })]
    });
    assert.deepEqual(
      config.locations.map((l) => [l.id, l.enabled]),
      [
        ["rgia", true],
        ["other", false]
      ]
    );
  });

  it("defaults the time zone to Asia/Kolkata (IST)", () => {
    const config = parseConfig({ locations: [location()] });
    assert.equal(config.timeZone, "Asia/Kolkata");
    assert.equal(config.timeZoneLabel, "IST");
  });

  it("rejects duplicate ids", () => {
    assert.deepEqual(problemsOf({ locations: [location(), location()] }), [
      'locations[1].id "rgia" is used more than once'
    ]);
  });

  it("rejects out-of-range coordinates", () => {
    const problems = problemsOf({
      locations: [location({ latitude: 91, longitude: -181 })]
    });
    assert.deepEqual(problems, [
      "locations[0].latitude must be a number between -90 and 90",
      "locations[0].longitude must be a number between -180 and 180"
    ]);
  });

  it("rejects non-positive radii and radii beyond the provider limit", () => {
    assert.deepEqual(problemsOf({ locations: [location({ radiusKm: 0 })] }), [
      "locations[0].radiusKm must be a positive number"
    ]);
    assert.match(
      problemsOf({ locations: [location({ radiusKm: 500 })] })[0]!,
      /at most 463/
    );
  });

  it("requires boolean enabled flags, string names and safe ids", () => {
    const problems = problemsOf({
      locations: [location({ id: "Bad Id", name: " ", enabled: "yes" })]
    });
    assert.equal(problems.length, 3);
    assert.match(problems.join("\n"), /id must be lowercase/);
    assert.match(problems.join("\n"), /name must be a non-empty string/);
    assert.match(problems.join("\n"), /enabled must be true or false/);
  });

  it("flags unknown properties so typos are not silently ignored", () => {
    assert.deepEqual(problemsOf({ locations: [location({ radius: 5 })] }), [
      'locations[0] has unknown property "radius"'
    ]);
    assert.deepEqual(problemsOf({ locations: [location()], extra: 1 }), [
      'unknown property "extra"'
    ]);
  });

  it("requires at least one enabled location", () => {
    assert.deepEqual(
      problemsOf({ locations: [location({ enabled: false })] }),
      ['at least one location must have "enabled": true']
    );
  });

  it("rejects invalid time zones", () => {
    assert.match(
      problemsOf({ timeZone: "Mars/Olympus", locations: [location()] })[0]!,
      /valid IANA time zone/
    );
  });
});

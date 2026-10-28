import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { ConfigError } from "@watch-flights/core";
import { loadConfig } from "../src/config-file.js";

const SHIPPED_CONFIG = fileURLToPath(
  new URL("../../../config/locations.json", import.meta.url)
);

describe("config file", () => {
  it("ships the registered locations, enabled, with the documented coordinates and radii", async () => {
    const config = await loadConfig(SHIPPED_CONFIG);
    assert.equal(config.timeZone, "Asia/Kolkata");
    assert.equal(config.timeZoneLabel, "IST");
    assert.deepEqual(config.locations, [
      {
        id: "rgia",
        name: "RGIA, Hyderabad",
        latitude: 17.239943874504426,
        longitude: 78.42947104117285,
        radiusKm: 100,
        enabled: true
      },
      {
        id: "lucknow",
        name: "Chaudhary Charan Singh International Airport, Lucknow",
        latitude: 26.761944,
        longitude: 80.883333,
        radiusKm: 100,
        enabled: true
      },
      {
        id: "raebareli",
        name: "Raebareli",
        latitude: 26.2309,
        longitude: 81.2336,
        radiusKm: 30,
        enabled: true
      },
      {
        id: "delhi",
        name: "Indira Gandhi International Airport, Delhi",
        latitude: 28.568611,
        longitude: 77.112222,
        radiusKm: 100,
        enabled: true
      }
    ]);
  });

  it("Lucknow coordinates match the AAI reference point 26°45′43″N 80°53′00″E", async () => {
    const lucknow = (await loadConfig(SHIPPED_CONFIG)).locations.find(
      (l) => l.id === "lucknow"
    )!;
    assert.ok(Math.abs(lucknow.latitude - (26 + 45 / 60 + 43 / 3600)) < 1e-6);
    assert.ok(Math.abs(lucknow.longitude - (80 + 53 / 60)) < 1e-6);
  });

  it("reports missing files and invalid JSON as ConfigError", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nf-config-"));
    await assert.rejects(
      loadConfig(join(dir, "missing.json")),
      (e: unknown) =>
        e instanceof ConfigError && e.problems[0] === "file not found"
    );
    const broken = join(dir, "broken.json");
    await writeFile(broken, '{ "locations": [ ');
    await assert.rejects(
      loadConfig(broken),
      (e: unknown) =>
        e instanceof ConfigError && /not valid JSON/.test(e.problems[0]!)
    );
  });
});

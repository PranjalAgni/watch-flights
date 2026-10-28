import { kmToNm } from "./geo.js";
import type { Location } from "./types.js";

export interface AppConfig {
  timeZone: string;
  timeZoneLabel: string;
  locations: Location[];
}

/** ADSB.lol caps point queries at 250 nautical miles. */
export const MAX_RADIUS_NM = 250;
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const TOP_LEVEL_KEYS = new Set(["timeZone", "timeZoneLabel", "locations"]);
const LOCATION_KEYS = new Set([
  "id",
  "name",
  "latitude",
  "longitude",
  "radiusKm",
  "enabled"
]);

export class ConfigError extends Error {
  constructor(
    readonly path: string,
    readonly problems: readonly string[]
  ) {
    super(
      `Invalid configuration in ${path}:\n${problems.map((p) => `  - ${p}`).join("\n")}`
    );
    this.name = "ConfigError";
  }
}

export function parseConfig(raw: unknown, path = "config"): AppConfig {
  const problems: string[] = [];
  if (!isRecord(raw))
    throw new ConfigError(path, ["top level must be a JSON object"]);

  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_KEYS.has(key)) problems.push(`unknown property "${key}"`);
  }

  const timeZone = raw.timeZone ?? "Asia/Kolkata";
  if (typeof timeZone !== "string" || !isValidTimeZone(timeZone)) {
    problems.push(
      '"timeZone" must be a valid IANA time zone, e.g. "Asia/Kolkata"'
    );
  }
  const timeZoneLabel = raw.timeZoneLabel ?? "IST";
  if (typeof timeZoneLabel !== "string" || timeZoneLabel.trim() === "") {
    problems.push('"timeZoneLabel" must be a non-empty string');
  }

  const locations: Location[] = [];
  if (!Array.isArray(raw.locations)) {
    problems.push('"locations" must be an array');
  } else {
    const seen = new Set<string>();
    raw.locations.forEach((entry, index) => {
      const id = isRecord(entry) ? entry.id : undefined;
      if (typeof id === "string") {
        if (seen.has(id))
          problems.push(
            `locations[${index}].id "${id}" is used more than once`
          );
        seen.add(id);
      }
      const location = parseLocation(entry, `locations[${index}]`, problems);
      if (location) locations.push(location);
    });
    if (problems.length === 0 && !locations.some((l) => l.enabled)) {
      problems.push('at least one location must have "enabled": true');
    }
  }

  if (problems.length > 0) throw new ConfigError(path, problems);
  return {
    timeZone: timeZone as string,
    timeZoneLabel: (timeZoneLabel as string).trim(),
    locations
  };
}

function parseLocation(
  entry: unknown,
  at: string,
  problems: string[]
): Location | null {
  if (!isRecord(entry)) {
    problems.push(`${at} must be an object`);
    return null;
  }
  const before = problems.length;
  for (const key of Object.keys(entry)) {
    if (!LOCATION_KEYS.has(key))
      problems.push(`${at} has unknown property "${key}"`);
  }
  const { id, name, latitude, longitude, radiusKm, enabled } = entry;

  if (typeof id !== "string" || !ID_PATTERN.test(id)) {
    problems.push(
      `${at}.id must be lowercase letters, digits, "-" or "_" (e.g. "rgia")`
    );
  }
  if (typeof name !== "string" || name.trim() === "")
    problems.push(`${at}.name must be a non-empty string`);
  if (!isFiniteNumber(latitude) || latitude < -90 || latitude > 90) {
    problems.push(`${at}.latitude must be a number between -90 and 90`);
  }
  if (!isFiniteNumber(longitude) || longitude < -180 || longitude > 180) {
    problems.push(`${at}.longitude must be a number between -180 and 180`);
  }
  if (!isFiniteNumber(radiusKm) || radiusKm <= 0) {
    problems.push(`${at}.radiusKm must be a positive number`);
  } else if (kmToNm(radiusKm) > MAX_RADIUS_NM) {
    problems.push(
      `${at}.radiusKm must be at most ${Math.floor(MAX_RADIUS_NM * 1.852)} (${MAX_RADIUS_NM} nm provider limit)`
    );
  }
  if (typeof enabled !== "boolean")
    problems.push(`${at}.enabled must be true or false`);

  if (problems.length > before) return null;
  return {
    id: id as string,
    name: (name as string).trim(),
    latitude: latitude as number,
    longitude: longitude as number,
    radiusKm: radiusKm as number,
    enabled: enabled as boolean
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone });
    return true;
  } catch {
    return false;
  }
}

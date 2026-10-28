import {
  bearingDeg,
  distanceKm,
  knotsToKmh,
  nmToKm,
  normalizeDeg
} from "./geo.js";
import type { AdsbLolResponse } from "./providers/adsblol.js";
import type {
  AircraftPosition,
  Altitude,
  Location,
  Snapshot
} from "./types.js";

const HEX_PATTERN = /^~?[0-9a-f]{6}$/;

export function normalizeSnapshot(
  response: AdsbLolResponse,
  location: Location,
  fetchedAtMs: number
): Snapshot {
  const byHex = new Map<string, AircraftPosition>();
  for (const raw of response.aircraft) {
    const aircraft = normalizeAircraft(raw, location, response.nowMs);
    if (!aircraft || aircraft.altitude?.kind === "ground") continue;
    const existing = byHex.get(aircraft.hex);
    if (
      !existing ||
      (aircraft.positionAtMs ?? -Infinity) >
        (existing.positionAtMs ?? -Infinity)
    ) {
      byHex.set(aircraft.hex, aircraft);
    }
  }
  return { fetchedAtMs, aircraft: [...byHex.values()].sort(compareByDistance) };
}

export function normalizeAircraft(
  raw: Record<string, unknown>,
  location: Location,
  responseNowMs: number
): AircraftPosition | null {
  const hex = typeof raw.hex === "string" ? raw.hex.trim().toLowerCase() : "";
  if (!HEX_PATTERN.test(hex)) return null;

  const latitude = numberIn(raw.lat, -90, 90);
  const longitude = numberIn(raw.lon, -180, 180);
  const hasPosition = latitude !== null && longitude !== null;

  const providerDistanceNm = numberIn(raw.dst, 0, Infinity);
  const providerBearing = numberIn(raw.dir, -360, 360);
  const seenPos = numberIn(raw.seen_pos, 0, Infinity);
  const groundSpeed = numberIn(raw.gs, 0, Infinity);
  const track = numberIn(raw.track, -360, 360);

  return {
    hex,
    callsign: text(raw.flight),
    feed: {
      registration: text(raw.r),
      typeCode: text(raw.t),
      description: text(raw.desc),
      ownerOperator: text(raw.ownOp)
    },
    latitude,
    longitude,
    altitude: altitude(raw.alt_baro),
    groundSpeedKmh: groundSpeed === null ? null : knotsToKmh(groundSpeed),
    trackDeg: track === null ? null : normalizeDeg(track),
    distanceKm:
      providerDistanceNm !== null
        ? nmToKm(providerDistanceNm)
        : hasPosition
          ? distanceKm(
              location.latitude,
              location.longitude,
              latitude,
              longitude
            )
          : null,
    bearingDeg:
      providerBearing !== null
        ? normalizeDeg(providerBearing)
        : hasPosition
          ? bearingDeg(
              location.latitude,
              location.longitude,
              latitude,
              longitude
            )
          : null,
    positionAtMs:
      seenPos === null || !hasPosition ? null : responseNowMs - seenPos * 1000
  };
}

export function compareByDistance(
  a: AircraftPosition,
  b: AircraftPosition
): number {
  if (a.distanceKm !== b.distanceKm) {
    if (a.distanceKm === null) return 1;
    if (b.distanceKm === null) return -1;
    return a.distanceKm - b.distanceKm;
  }
  return a.hex.localeCompare(b.hex);
}

function altitude(value: unknown): Altitude | null {
  if (value === "ground") return { kind: "ground" };
  if (typeof value === "number" && Number.isFinite(value))
    return { kind: "airborne", feet: value };
  return null;
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function numberIn(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max
    ? value
    : null;
}

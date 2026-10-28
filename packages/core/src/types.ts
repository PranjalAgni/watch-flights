export interface Location {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  radiusKm: number;
  enabled: boolean;
}

export type Altitude = { kind: "airborne"; feet: number } | { kind: "ground" };

/** One aircraft as seen from one location in one snapshot. */
export interface AircraftPosition {
  hex: string;
  callsign: string | null;
  /** Values reported inline by the position feed (may be absent). */
  feed: {
    registration: string | null;
    typeCode: string | null;
    description: string | null;
    ownerOperator: string | null;
  };
  latitude: number | null;
  longitude: number | null;
  altitude: Altitude | null;
  groundSpeedKmh: number | null;
  /** Direction of travel, degrees true. */
  trackDeg: number | null;
  /** Distance from the location to the aircraft. */
  distanceKm: number | null;
  /** Bearing from the location to the aircraft, degrees true. */
  bearingDeg: number | null;
  /** When the position was last updated (epoch ms), if known. */
  positionAtMs: number | null;
}

export interface Snapshot {
  fetchedAtMs: number;
  /** Airborne aircraft, nearest first. */
  aircraft: AircraftPosition[];
}

export interface LocationState {
  location: Location;
  lastSuccess: Snapshot | null;
  /** Set when the latest attempt failed; cleared by the next success. */
  lastError: { atMs: number; message: string } | null;
  fetching: boolean;
}

export type Verification = "reported" | "corroborated";

export interface Sourced<T> {
  value: T;
  source: string;
  verification: Verification;
}

export interface Airport {
  iata: string | null;
  icao: string | null;
  name: string | null;
  municipality: string | null;
  latitude: number;
  longitude: number;
}

/**
 * A scheduled route as published for a callsign. Callsigns get reused, so it
 * can be wrong.
 */
export interface FlightRoute {
  callsign: string;
  origin: Airport;
  destination: Airport;
}

/**
 * consistent: the aircraft is near an endpoint or along the great-circle path
 * between them.
 * inconsistent: it is far from both, so the published route probably belongs to
 * another flight.
 * unchecked: no position to compare against.
 */
export type RouteCheck = "consistent" | "inconsistent" | "unchecked";

export interface RouteInfo extends Sourced<FlightRoute> {
  check: RouteCheck;
}

export interface AircraftMetadata {
  registration: Sourced<string> | null;
  typeCode: Sourced<string> | null;
  model: Sourced<string> | null;
  /** Registered owner, when a source states it as such. */
  owner: Sourced<string> | null;
  /**
   * A source's combined owner-or-operator label, where the two are not
   * distinguished.
   */
  ownerOperator: Sourced<string> | null;
  route: RouteInfo | null;
}

export const KM_PER_NM = 1.852;
const EARTH_RADIUS_KM = 6371.0088;

export const nmToKm = (nm: number): number => nm * KM_PER_NM;
export const kmToNm = (km: number): number => km / KM_PER_NM;
export const knotsToKmh = (knots: number): number => knots * KM_PER_NM;

const toRad = (deg: number) => (deg * Math.PI) / 180;
const toDeg = (rad: number) => (rad * 180) / Math.PI;

export function distanceKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Initial great-circle bearing from point 1 to point 2, in degrees [0, 360).
 */
export function bearingDeg(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δλ = toRad(lon2 - lon1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return normalizeDeg(toDeg(Math.atan2(y, x)));
}

export function normalizeDeg(deg: number): number {
  const d = deg % 360;
  return d < 0 ? d + 360 : d;
}

const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;

export function compassPoint(deg: number): string {
  return COMPASS[Math.round(normalizeDeg(deg) / 45) % 8]!;
}

/** Within this of either endpoint, an aircraft is departing or arriving. */
const ROUTE_ENDPOINT_KM = 150;
/**
 * Airways rarely stray from the great circle by more than this share of the
 * route length.
 */
const ROUTE_CORRIDOR_SHARE = 0.15;
const ROUTE_CORRIDOR_MIN_KM = 100;

export interface LatLon {
  latitude: number;
  longitude: number;
}

/**
 * Whether a position is plausible for a flight from `origin` to `destination`:
 * near either airport, or inside a corridor around the great-circle path and
 * between its endpoints.
 */
export function isOnRoute(
  position: LatLon,
  origin: LatLon,
  destination: LatLon
): boolean {
  const toOrigin = distanceKm(
    origin.latitude,
    origin.longitude,
    position.latitude,
    position.longitude
  );
  const toDestination = distanceKm(
    destination.latitude,
    destination.longitude,
    position.latitude,
    position.longitude
  );
  if (Math.min(toOrigin, toDestination) <= ROUTE_ENDPOINT_KM) return true;

  const routeKm = distanceKm(
    origin.latitude,
    origin.longitude,
    destination.latitude,
    destination.longitude
  );
  const δ13 = toOrigin / EARTH_RADIUS_KM;
  const θ13 = toRad(
    bearingDeg(
      origin.latitude,
      origin.longitude,
      position.latitude,
      position.longitude
    )
  );
  const θ12 = toRad(
    bearingDeg(
      origin.latitude,
      origin.longitude,
      destination.latitude,
      destination.longitude
    )
  );
  const crossTrackKm =
    Math.asin(Math.sin(δ13) * Math.sin(θ13 - θ12)) * EARTH_RADIUS_KM;
  const alongTrackKm =
    Math.acos(
      Math.min(1, Math.cos(δ13) / Math.cos(crossTrackKm / EARTH_RADIUS_KM))
    ) * EARTH_RADIUS_KM;
  const ahead = Math.cos(θ13 - θ12) > 0;
  const corridorKm = Math.max(
    ROUTE_CORRIDOR_MIN_KM,
    routeKm * ROUTE_CORRIDOR_SHARE
  );
  return (
    Math.abs(crossTrackKm) <= corridorKm && ahead && alongTrackKm <= routeKm
  );
}

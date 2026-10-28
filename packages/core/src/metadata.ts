import type { AircraftDb } from "./aircraft-db.js";
import type { Clock } from "./clock.js";
import { isOnRoute } from "./geo.js";
import { createLimiter } from "./limit.js";
import type { AdsbdbAircraft } from "./providers/adsbdb.js";
import { RemoteCache } from "./remote-cache.js";
import type {
  AircraftMetadata,
  AircraftPosition,
  FlightRoute,
  RouteInfo,
  Sourced
} from "./types.js";

const HOUR_MS = 60 * 60 * 1000;
/**
 * ICAO-style flight callsigns: airline prefix plus flight number, at most 8
 * characters.
 */
const CALLSIGN = /^[A-Z0-9]{3,8}$/;

export interface RemoteMetadataSource {
  lookupAircraft(hex: string): Promise<AdsbdbAircraft | null>;
  lookupRoute(callsign: string): Promise<FlightRoute | null>;
}

export interface MetadataServiceOptions {
  clock: Clock;
  aircraftDb: () => AircraftDb;
  remote: RemoteMetadataSource | null;
  /**
   * Concurrent requests to the remote source, across aircraft and route
   * lookups.
   */
  concurrency?: number;
  hitTtlMs?: number;
  missTtlMs?: number;
  /**
   * Routes are tied to schedules and callsigns get reused, so they expire
   * sooner.
   */
  routeTtlMs?: number;
  errorRetryMs?: number;
}

/**
 * Aircraft metadata (keyed by hex) and routes (keyed by callsign), shared
 * across locations. Position-specific values (distance, bearing) never live
 * here.
 */
export class MetadataService {
  readonly #aircraft: RemoteCache<AdsbdbAircraft> | null = null;
  readonly #routes: RemoteCache<FlightRoute> | null = null;
  readonly #aircraftDb: () => AircraftDb;

  constructor(options: MetadataServiceOptions) {
    const {
      clock,
      remote,
      concurrency = 2,
      hitTtlMs = 24 * HOUR_MS,
      missTtlMs = 24 * HOUR_MS,
      routeTtlMs = 6 * HOUR_MS,
      errorRetryMs = 15 * 60 * 1000
    } = options;
    this.#aircraftDb = options.aircraftDb;
    if (!remote) return;
    const limit = createLimiter(concurrency);
    this.#aircraft = new RemoteCache((hex) => remote.lookupAircraft(hex), {
      clock,
      limit,
      hitTtlMs,
      missTtlMs,
      errorRetryMs
    });
    this.#routes = new RemoteCache((callsign) => remote.lookupRoute(callsign), {
      clock,
      limit,
      hitTtlMs: routeTtlMs,
      missTtlMs: routeTtlMs,
      errorRetryMs
    });
  }

  /**
   * Fetches remote metadata and routes that are not cached or in flight. Never
   * rejects.
   */
  async ensureRemote(aircraft: Iterable<AircraftPosition>): Promise<void> {
    if (!this.#aircraft || !this.#routes) return;
    const hexes: string[] = [];
    const callsigns: string[] = [];
    for (const position of aircraft) {
      // Non-ICAO addresses are not in registries.
      if (!position.hex.startsWith("~")) hexes.push(position.hex);
      const callsign = this.#routeCallsign(position);
      if (callsign) callsigns.push(callsign);
    }
    await Promise.all([
      this.#aircraft.ensure(hexes),
      this.#routes.ensure(callsigns)
    ]);
  }

  /**
   * The callsign to look a route up by, or null when it cannot have a published
   * route.
   */
  #routeCallsign(position: AircraftPosition): string | null {
    const callsign = position.callsign?.toUpperCase();
    if (!callsign || !CALLSIGN.test(callsign)) return null;
    // Private and general-aviation flights use the registration as the
    // callsign: no schedule.
    const registration =
      position.feed.registration ??
      this.#aircraftDb().lookup(position.hex)?.registration;
    if (
      registration &&
      registration.replace(/-/g, "").toUpperCase() === callsign
    )
      return null;
    return callsign;
  }

  resolve(position: AircraftPosition): AircraftMetadata {
    const local = this.#aircraftDb().lookup(position.hex);
    const remote = this.#aircraft?.get(position.hex) ?? null;

    const remoteModel = remote
      ? [remote.manufacturer, remote.type].filter(Boolean).join(" ") || null
      : null;

    return {
      registration: pick([
        ["adsb.lol", position.feed.registration],
        ["tar1090-db", local?.registration],
        ["adsbdb", remote?.registration]
      ]),
      typeCode: pick([
        ["adsb.lol", position.feed.typeCode],
        ["tar1090-db", local?.typeCode],
        ["adsbdb", remote?.icaoType]
      ]),
      model: pick([
        ["tar1090-db", local?.description],
        ["adsb.lol", position.feed.description],
        ["adsbdb", remoteModel]
      ]),
      owner: pick([["adsbdb", remote?.registeredOwner]]),
      ownerOperator: pick([
        ["adsb.lol", position.feed.ownerOperator],
        ["tar1090-db", local?.ownerOperator]
      ]),
      route: this.#route(position)
    };
  }

  #route(position: AircraftPosition): RouteInfo | null {
    const callsign = this.#routeCallsign(position);
    const route = callsign ? (this.#routes?.get(callsign) ?? null) : null;
    if (!route) return null;
    const { latitude, longitude } = position;
    const check =
      latitude === null || longitude === null
        ? "unchecked"
        : isOnRoute({ latitude, longitude }, route.origin, route.destination)
          ? "consistent"
          : "inconsistent";
    return { value: route, source: "adsbdb", verification: "reported", check };
  }
}

/**
 * First available value wins; it is "corroborated" when another source reports
 * the same value.
 */
function pick(
  candidates: [source: string, value: string | null | undefined][]
): Sourced<string> | null {
  const available = candidates.filter(
    (c): c is [string, string] => typeof c[1] === "string" && c[1] !== ""
  );
  const first = available[0];
  if (!first) return null;
  const [source, value] = first;
  const agrees = available
    .slice(1)
    .some(([, other]) => other.toUpperCase() === value.toUpperCase());
  return { value, source, verification: agrees ? "corroborated" : "reported" };
}

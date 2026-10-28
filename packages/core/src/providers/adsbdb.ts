import type { Airport, FlightRoute } from "../types.js";
import { decodeUtf8, type HttpClient, RateGate } from "../http.js";
import { ProviderSchemaError } from "./errors.js";

export const ADSBDB_BASE_URL = "https://api.adsbdb.com";

export interface AdsbdbAircraft {
  registration: string | null;
  icaoType: string | null;
  type: string | null;
  manufacturer: string | null;
  registeredOwner: string | null;
  ownerCountry: string | null;
  ownerOperatorFlagCode: string | null;
}

/**
 * Returns null when ADSBdb says it does not know the aircraft. Any other 404
 * (for example a proxy error page) is an error, so it is retried soon instead
 * of being cached as a miss.
 */
export function parseAdsbdbAircraftResponse(
  status: number,
  body: unknown
): AdsbdbAircraft | null {
  const response =
    typeof body === "object" && body !== null
      ? (body as Record<string, unknown>).response
      : undefined;
  if (response === "unknown aircraft") return null;
  if (status === 404)
    throw new ProviderSchemaError(
      "ADSBdb",
      'HTTP 404 without an "unknown aircraft" answer'
    );
  const aircraft =
    typeof response === "object" && response !== null
      ? (response as Record<string, unknown>).aircraft
      : undefined;
  if (typeof aircraft !== "object" || aircraft === null)
    throw new ProviderSchemaError("ADSBdb", "missing aircraft");
  const a = aircraft as Record<string, unknown>;
  return {
    registration: text(a.registration),
    icaoType: text(a.icao_type),
    type: text(a.type),
    manufacturer: text(a.manufacturer),
    registeredOwner: text(a.registered_owner),
    ownerCountry: text(a.registered_owner_country_name),
    ownerOperatorFlagCode: text(a.registered_owner_operator_flag_code)
  };
}

/** Returns null when ADSBdb says it has no route for the callsign. */
export function parseAdsbdbCallsignResponse(
  status: number,
  body: unknown
): FlightRoute | null {
  const response =
    typeof body === "object" && body !== null
      ? (body as Record<string, unknown>).response
      : undefined;
  if (response === "unknown callsign") return null;
  if (status === 404)
    throw new ProviderSchemaError(
      "ADSBdb",
      'HTTP 404 without an "unknown callsign" answer'
    );
  const route =
    typeof response === "object" && response !== null
      ? (response as Record<string, unknown>).flightroute
      : undefined;
  if (typeof route !== "object" || route === null)
    throw new ProviderSchemaError("ADSBdb", "missing flightroute");
  const r = route as Record<string, unknown>;
  const callsign = text(r.callsign);
  const origin = airport(r.origin);
  const destination = airport(r.destination);
  if (!callsign || !origin || !destination)
    throw new ProviderSchemaError("ADSBdb", "incomplete flightroute");
  return { callsign, origin, destination };
}

function airport(value: unknown): Airport | null {
  if (typeof value !== "object" || value === null) return null;
  const a = value as Record<string, unknown>;
  const { latitude, longitude } = a;
  if (
    typeof latitude !== "number" ||
    typeof longitude !== "number" ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude)
  ) {
    return null;
  }
  const iata = text(a.iata_code);
  const icao = text(a.icao_code);
  if (!iata && !icao) return null;
  return {
    iata,
    icao,
    name: text(a.name),
    municipality: text(a.municipality),
    latitude,
    longitude
  };
}

export class AdsbdbClient {
  readonly gate = new RateGate();

  constructor(
    private readonly http: HttpClient,
    private readonly baseUrl = ADSBDB_BASE_URL
  ) {}

  async lookupAircraft(hex: string): Promise<AdsbdbAircraft | null> {
    const { status, body } = await this.#getJson(
      `/v0/aircraft/${encodeURIComponent(hex)}`
    );
    return parseAdsbdbAircraftResponse(status, body);
  }

  async lookupRoute(callsign: string): Promise<FlightRoute | null> {
    const { status, body } = await this.#getJson(
      `/v0/callsign/${encodeURIComponent(callsign)}`
    );
    return parseAdsbdbCallsignResponse(status, body);
  }

  async #getJson(path: string): Promise<{ status: number; body: unknown }> {
    const response = await this.http.get(`${this.baseUrl}${path}`, {
      timeoutMs: 8_000,
      retries: 1,
      acceptStatuses: [200, 404],
      gate: this.gate,
      headers: { accept: "application/json" }
    });
    try {
      return {
        status: response.status,
        body: JSON.parse(decodeUtf8(response.body))
      };
    } catch {
      throw new ProviderSchemaError(
        "ADSBdb",
        `HTTP ${response.status} body is not JSON`
      );
    }
  }
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

import { kmToNm } from "../geo.js";
import { type HttpClient, RateGate } from "../http.js";
import type { Location } from "../types.js";
import { ProviderSchemaError } from "./errors.js";

export const ADSBLOL_BASE_URL = "https://api.adsb.lol";

export interface AdsbLolResponse {
  /** Server time the snapshot refers to, epoch ms. */
  nowMs: number;
  /** Raw aircraft records that at least carry a hex string. */
  aircraft: Record<string, unknown>[];
  /** Records dropped because they were not objects with a hex. */
  rejected: number;
}

export function pointUrl(
  location: Location,
  baseUrl = ADSBLOL_BASE_URL
): string {
  const radiusNm = Math.round(kmToNm(location.radiusKm) * 1000) / 1000;
  return `${baseUrl}/v2/point/${location.latitude}/${location.longitude}/${radiusNm}`;
}

export function parseAdsbLolResponse(body: unknown): AdsbLolResponse {
  if (typeof body !== "object" || body === null)
    throw new ProviderSchemaError("ADSB.lol", "not an object");
  const { now, ac } = body as Record<string, unknown>;
  if (typeof now !== "number" || !Number.isFinite(now) || now <= 0) {
    throw new ProviderSchemaError("ADSB.lol", 'missing "now" timestamp');
  }
  if (!Array.isArray(ac))
    throw new ProviderSchemaError("ADSB.lol", 'missing "ac" list');

  const aircraft: Record<string, unknown>[] = [];
  let rejected = 0;
  for (const entry of ac) {
    if (
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as Record<string, unknown>).hex === "string"
    ) {
      aircraft.push(entry as Record<string, unknown>);
    } else {
      rejected++;
    }
  }
  // Observed responses use epoch milliseconds; tolerate seconds defensively.
  const nowMs = now < 1e11 ? now * 1000 : now;
  return { nowMs, aircraft, rejected };
}

export class AdsbLolClient {
  readonly gate = new RateGate();

  constructor(
    private readonly http: HttpClient,
    private readonly baseUrl = ADSBLOL_BASE_URL
  ) {}

  async fetchPoint(location: Location): Promise<AdsbLolResponse> {
    const response = await this.http.get(pointUrl(location, this.baseUrl), {
      timeoutMs: 10_000,
      retries: 2,
      gate: this.gate,
      headers: { accept: "application/json" }
    });
    let body: unknown;
    try {
      body = JSON.parse(response.body.toString("utf8"));
    } catch {
      throw new ProviderSchemaError("ADSB.lol", "body is not JSON");
    }
    return parseAdsbLolResponse(body);
  }
}

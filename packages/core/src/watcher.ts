import type { Clock } from "./clock.js";
import { describeError } from "./http.js";
import { createLimiter } from "./limit.js";
import type { MetadataService } from "./metadata.js";
import { normalizeSnapshot } from "./normalize.js";
import type { AdsbLolResponse } from "./providers/adsblol.js";
import type { Location, LocationState } from "./types.js";

export interface PositionSource {
  fetchPoint(location: Location): Promise<AdsbLolResponse>;
}

export interface FlightWatcherOptions {
  locations: readonly Location[];
  positions: PositionSource;
  metadata: MetadataService;
  clock: Clock;
  concurrency?: number;
  onUpdate?: () => void;
}

/**
 * Holds independent per-location state; one location failing never blocks
 * another.
 */
export class FlightWatcher {
  readonly states: readonly LocationState[];
  /** Settles when metadata lookups started by the latest cycle finish. */
  enrichment: Promise<void> = Promise.resolve();

  constructor(private readonly options: FlightWatcherOptions) {
    this.states = options.locations
      .filter((location) => location.enabled)
      .map((location) => ({
        location,
        lastSuccess: null,
        lastError: null,
        fetching: false
      }));
  }

  /**
   * Fetches every location, then starts metadata enrichment in the background.
   */
  async runCycle(): Promise<void> {
    const limit = createLimiter(this.options.concurrency ?? 2);
    await Promise.all(
      this.states.map((state) => limit(() => this.#poll(state)))
    );

    const aircraft = this.states.flatMap(
      (state) => state.lastSuccess?.aircraft ?? []
    );
    this.enrichment = this.options.metadata
      .ensureRemote(aircraft)
      .then(() => this.#notify());
  }

  async #poll(state: LocationState): Promise<void> {
    const { positions, clock } = this.options;
    state.fetching = true;
    this.#notify();
    try {
      const response = await positions.fetchPoint(state.location);
      state.lastSuccess = normalizeSnapshot(
        response,
        state.location,
        clock.now()
      );
      state.lastError = null;
    } catch (error) {
      state.lastError = { atMs: clock.now(), message: describeError(error) };
    } finally {
      state.fetching = false;
      this.#notify();
    }
  }

  #notify() {
    this.options.onUpdate?.();
  }
}

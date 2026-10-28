import {
  AdsbdbClient,
  AdsbLolClient,
  AircraftDb,
  type AircraftMetadata,
  type AircraftPosition,
  FlightWatcher,
  HttpClient,
  type Location,
  type LocationState,
  MetadataService,
  POLL_INTERVAL_MS,
  PollScheduler,
  systemClock
} from "@watch-flights/core";
import { useEffect, useState, useSyncExternalStore } from "react";
import { AppState } from "react-native";

const clock = systemClock;
const http = new HttpClient({ clock, userAgent: "nearby-flights-ios/1.0" });
const positions = new AdsbLolClient(http);
/**
 * Shared across location changes so cached owners and routes survive. The
 * 40 MB tar1090-db is not shipped on the phone: registration, type and model
 * come from the position feed and ADSBdb.
 */
const metadata = new MetadataService({
  clock,
  aircraftDb: () => AircraftDb.empty,
  remote: new AdsbdbClient(http)
});

interface Session {
  watcher: FlightWatcher;
  scheduler: PollScheduler;
}

/**
 * Bridges the polling engine, which mutates its location states in place, to
 * React: every change bumps a version that components subscribe to.
 */
class FlightTracker {
  #session: Session | null = null;
  #version = 0;
  #frame: number | null = null;
  readonly #listeners = new Set<() => void>();

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  readonly version = (): number => this.#version;

  /** Starts polling `locations`; returns a function that stops it. */
  watch(locations: readonly Location[]): () => void {
    let disposed = false;
    const changed = () => {
      if (!disposed) this.#changed();
    };
    const watcher = new FlightWatcher({
      locations,
      positions,
      metadata,
      clock,
      onUpdate: changed
    });
    const scheduler = new PollScheduler({
      clock,
      intervalMs: POLL_INTERVAL_MS,
      run: () => watcher.runCycle(),
      onScheduled: changed
    });
    const session = { watcher, scheduler };
    this.#session = session;
    scheduler.start();
    this.#changed();
    return () => {
      disposed = true;
      void scheduler.stop();
      if (this.#session === session) this.#session = null;
    };
  }

  get states(): readonly LocationState[] {
    return this.#session?.watcher.states ?? [];
  }

  /** Null while a cycle is running. */
  get nextRefreshAtMs(): number | null {
    return this.#session?.scheduler.nextRunAtMs ?? null;
  }

  readonly refresh = (): Promise<void> =>
    this.#session?.scheduler.refreshNow() ?? Promise.resolve();

  readonly wake = (): void => this.#session?.scheduler.wake();

  readonly resolve = (aircraft: AircraftPosition): AircraftMetadata =>
    metadata.resolve(aircraft);

  /**
   * Coalesces bursts of updates (one per location and per lookup) into one
   * render per frame.
   */
  #changed(): void {
    if (this.#frame !== null) return;
    this.#frame = requestAnimationFrame(() => {
      this.#frame = null;
      this.#version++;
      for (const listener of this.#listeners) listener();
    });
  }
}

export const tracker = new FlightTracker();

/** Polls the enabled locations every five minutes while mounted. */
export function useFlightTracker(locations: readonly Location[]) {
  useEffect(() => tracker.watch(locations), [locations]);
  useEffect(() => {
    // iOS suspends the app in the background; catch up as soon as it returns.
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") tracker.wake();
    });
    return () => subscription.remove();
  }, []);
  useSyncExternalStore(tracker.subscribe, tracker.version);

  const states = tracker.states;
  const fetchedAt = states
    .map((state) => state.lastSuccess?.fetchedAtMs ?? null)
    .filter((ms): ms is number => ms !== null);
  return {
    states,
    nextRefreshAtMs: tracker.nextRefreshAtMs,
    /** Time of the most recent successful fetch of any location. */
    lastUpdatedAtMs: fetchedAt.length > 0 ? Math.max(...fetchedAt) : null
  };
}

/** The current time, updated every second. */
export function useNow(): number {
  const [now, setNow] = useState(clock.now);
  useEffect(() => {
    const id = setInterval(() => setNow(clock.now()), 1_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

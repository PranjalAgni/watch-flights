import type { Clock } from "./clock.js";

export const POLL_INTERVAL_MS = 300_000;
/**
 * Timers pause while the machine sleeps, but the wall clock does not, so the
 * due time is re-checked against the wall clock at least this often.
 */
const WALL_CLOCK_CHECK_MS = 10_000;

export interface PollSchedulerOptions {
  clock: Clock;
  intervalMs: number;
  run: () => Promise<void>;
  onError?: (error: unknown) => void;
  onScheduled?: () => void;
}

/**
 * Runs immediately, then every `intervalMs` measured from each cycle's start.
 * Cycles never overlap; if one overruns (or the machine slept), the next runs
 * once as soon as possible and missed cycles are not replayed.
 */
export class PollScheduler {
  #timer: unknown = null;
  #current: Promise<void> | null = null;
  #stopped = true;
  #nextRunAtMs: number | null = null;

  constructor(private readonly options: PollSchedulerOptions) {}

  /** Null while a cycle is running or the scheduler is stopped. */
  get nextRunAtMs(): number | null {
    return this.#nextRunAtMs;
  }

  get running(): boolean {
    return this.#current !== null;
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#runCycle();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer !== null) this.options.clock.clearTimeout(this.#timer);
    this.#timer = null;
    this.#nextRunAtMs = null;
    await this.#current;
  }

  #runCycle(): void {
    const { clock, intervalMs, run, onError, onScheduled } = this.options;
    this.#timer = null;
    this.#nextRunAtMs = null;
    const startedAt = clock.now();
    this.#current = Promise.resolve()
      .then(run)
      .catch((error: unknown) => onError?.(error))
      .finally(() => {
        this.#current = null;
        if (this.#stopped) return;
        this.#nextRunAtMs = Math.max(startedAt + intervalMs, clock.now());
        this.#arm();
        onScheduled?.();
      });
  }

  #arm(): void {
    const { clock } = this.options;
    const remaining = (this.#nextRunAtMs ?? 0) - clock.now();
    if (remaining <= 0) {
      this.#runCycle();
      return;
    }
    this.#timer = clock.setTimeout(
      () => this.#arm(),
      Math.min(remaining, WALL_CLOCK_CHECK_MS)
    );
  }
}

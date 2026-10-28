import type { Clock } from "../../src/clock.js";

interface Timer {
  at: number;
  seq: number;
  fn: () => void;
}

/** Deterministic clock: time only moves through advance(). */
export class FakeClock implements Clock {
  #now: number;
  #seq = 0;
  readonly #timers = new Map<number, Timer>();

  constructor(startMs = Date.UTC(2026, 9, 28, 10, 0, 0)) {
    this.#now = startMs;
  }

  now(): number {
    return this.#now;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.#seq;
    this.#timers.set(id, { at: this.#now + Math.max(0, ms), seq: id, fn });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.#timers.delete(handle as number);
  }

  get pendingTimers(): number {
    return this.#timers.size;
  }

  /**
   * Simulates the machine sleeping: the wall clock jumps but pending timers
   * keep their remaining delay, as Node timers do not count suspended time.
   */
  sleepMachine(ms: number): void {
    this.#now += ms;
    for (const timer of this.#timers.values()) timer.at += ms;
  }

  /**
   * Moves time forward, firing due timers in order and letting promise chains
   * settle between them.
   */
  async advance(ms: number): Promise<void> {
    const target = this.#now + ms;
    await flush();
    for (;;) {
      const next = [...this.#timers.entries()]
        .filter(([, t]) => t.at <= target)
        .sort(([, a], [, b]) => a.at - b.at || a.seq - b.seq)[0];
      if (!next) break;
      const [id, timer] = next;
      this.#timers.delete(id);
      this.#now = timer.at;
      timer.fn();
      await flush();
    }
    this.#now = target;
    await flush();
  }
}

export async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++)
    await new Promise<void>((resolve) => setImmediate(resolve));
}

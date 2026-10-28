import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { POLL_INTERVAL_MS, PollScheduler } from "../src/scheduler.js";
import { FakeClock } from "./helpers/fake-clock.js";

function setup(cycleDurationMs = 0) {
  const clock = new FakeClock();
  const starts: number[] = [];
  let active = 0;
  let maxActive = 0;
  const scheduler = new PollScheduler({
    clock,
    intervalMs: POLL_INTERVAL_MS,
    run: async () => {
      starts.push(clock.now());
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) =>
        clock.setTimeout(resolve, cycleDurationMs)
      );
      active--;
    }
  });
  /**
   * stop() waits for a running cycle, so let fake time pass while it finishes.
   */
  const stop = async () => {
    const stopped = scheduler.stop();
    await clock.advance(cycleDurationMs);
    await stopped;
  };
  return { clock, scheduler, starts, maxActive: () => maxActive, stop };
}

describe("PollScheduler", () => {
  it("uses a five-minute interval", () => {
    assert.equal(POLL_INTERVAL_MS, 300_000);
  });

  it("fetches immediately on start, then every five minutes from each cycle start", async () => {
    const { clock, scheduler, starts, stop } = setup(2_000);
    const t0 = clock.now();
    scheduler.start();
    await clock.advance(0);
    assert.deepEqual(starts, [t0]);
    await clock.advance(2_000);
    assert.equal(scheduler.nextRunAtMs, t0 + 300_000);
    await clock.advance(298_000);
    assert.deepEqual(starts, [t0, t0 + 300_000]);
    await clock.advance(300_000);
    assert.deepEqual(starts, [t0, t0 + 300_000, t0 + 600_000]);
    await stop();
  });

  it("does nothing between polls (countdown ticks never trigger requests)", async () => {
    const { clock, scheduler, starts } = setup();
    scheduler.start();
    for (let second = 0; second < 299; second++) await clock.advance(1_000);
    assert.equal(starts.length, 1);
    await scheduler.stop();
  });

  it("never overlaps cycles, and an overrun is followed by a single cycle, not a burst", async () => {
    const { clock, scheduler, starts, maxActive, stop } = setup(16 * 60_000);
    const t0 = clock.now();
    scheduler.start();
    await clock.advance(16 * 60_000);
    // The first cycle overran three intervals; exactly one new cycle starts
    // now.
    assert.deepEqual(starts, [t0, t0 + 16 * 60_000]);
    assert.equal(maxActive(), 1);
    await stop();
  });

  it("polls promptly after the machine wakes from sleep, once", async () => {
    const { clock, scheduler, starts } = setup();
    const t0 = clock.now();
    scheduler.start();
    await clock.advance(60_000);
    clock.sleepMachine(30 * 60_000);
    await clock.advance(10_000);
    assert.equal(
      starts.length,
      2,
      "one catch-up poll, no replay of the missed ones"
    );
    assert.ok(starts[1]! - t0 <= 31 * 60_000 + 10_000);
    assert.equal(scheduler.nextRunAtMs, starts[1]! + POLL_INTERVAL_MS);
    await scheduler.stop();
  });

  it("keeps polling after a failed cycle", async () => {
    const clock = new FakeClock();
    const errors: unknown[] = [];
    let runs = 0;
    const scheduler = new PollScheduler({
      clock,
      intervalMs: POLL_INTERVAL_MS,
      run: async () => {
        runs++;
        throw new Error("boom");
      },
      onError: (error) => errors.push(error)
    });
    scheduler.start();
    await clock.advance(POLL_INTERVAL_MS);
    assert.equal(runs, 2);
    assert.equal(errors.length, 2);
    await scheduler.stop();
  });

  it("stop() waits for the running cycle and schedules nothing more", async () => {
    const { clock, scheduler, starts } = setup(5_000);
    scheduler.start();
    await clock.advance(0);
    const stopped = scheduler.stop();
    await clock.advance(5_000);
    await stopped;
    await clock.advance(10 * POLL_INTERVAL_MS);
    assert.equal(starts.length, 1);
    assert.equal(clock.pendingTimers, 0);
    assert.equal(scheduler.nextRunAtMs, null);
  });
});

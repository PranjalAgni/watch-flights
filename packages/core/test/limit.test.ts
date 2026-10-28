import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLimiter } from "../src/limit.js";

describe("createLimiter", () => {
  it("releases the slot when a task throws synchronously", async () => {
    const limit = createLimiter(1);
    const boom = (): Promise<never> => {
      throw new Error("boom");
    };
    await assert.rejects(limit(boom), /boom/);
    assert.equal(await limit(async () => "next"), "next");
  });

  it("runs at most `concurrency` tasks at once, in FIFO order", async () => {
    const limit = createLimiter(2);
    let active = 0;
    let peak = 0;
    const order: number[] = [];
    await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        limit(async () => {
          active++;
          peak = Math.max(peak, active);
          order.push(n);
          await new Promise((resolve) => setImmediate(resolve));
          active--;
        })
      )
    );
    assert.equal(peak, 2);
    assert.deepEqual(order, [1, 2, 3, 4, 5]);
  });
});

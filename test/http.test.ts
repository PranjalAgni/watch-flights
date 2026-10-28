import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  HttpClient,
  HttpError,
  parseRetryAfter,
  RateGate
} from "../src/http.js";
import { FakeClock } from "./helpers/fake-clock.js";
import { fakeFetch, hang, json } from "./helpers/fake-fetch.js";

const options = { timeoutMs: 10_000, retries: 2 };

describe("HttpClient", () => {
  it("times out a hanging request and retries with backoff before giving up", async () => {
    const clock = new FakeClock();
    const { fetch, calls } = fakeFetch(hang);
    const request = new HttpClient({ clock, fetch }).get(
      "https://x.test/a",
      options
    );
    const outcome = request.then(
      () => assert.fail("should not resolve"),
      (error: unknown) => error
    );
    // 3 attempts x 10 s timeouts + 1 s + 2 s backoff.
    await clock.advance(32_999);
    assert.equal(calls.length, 3);
    await clock.advance(1);
    const error = await outcome;
    assert.ok(error instanceof HttpError);
    assert.equal(error.kind, "timeout");
    assert.equal(error.message, "timed out after 10s");
  });

  it("retries 5xx responses and returns the eventual success", async () => {
    const clock = new FakeClock();
    let n = 0;
    const { fetch } = fakeFetch(() =>
      ++n < 3 ? json({}, 503) : json({ ok: true })
    );
    const request = new HttpClient({ clock, fetch }).get(
      "https://x.test/a",
      options
    );
    await clock.advance(3_000);
    const response = await request;
    assert.equal(response.status, 200);
    assert.equal(n, 3);
  });

  it("does not retry other 4xx statuses", async () => {
    const { fetch, calls } = fakeFetch(() => json({}, 403));
    await assert.rejects(
      new HttpClient({ clock: new FakeClock(), fetch }).get(
        "https://x.test/a",
        options
      ),
      /HTTP 403/
    );
    assert.equal(calls.length, 1);
  });

  it("honours Retry-After on 429 and shares the cooldown through the gate", async () => {
    const clock = new FakeClock();
    const gate = new RateGate();
    let n = 0;
    const { fetch, calls } = fakeFetch(() =>
      ++n === 1 ? json({}, 429, { "retry-after": "5" }) : json({ ok: true })
    );
    const http = new HttpClient({ clock, fetch });
    const first = http.get("https://x.test/a", { ...options, gate });
    await clock.advance(0);
    assert.equal(gate.blockedUntilMs, clock.now() + 5_000);
    const second = http.get("https://x.test/b", { ...options, gate });
    await clock.advance(4_999);
    assert.equal(calls.length, 1, "nothing is sent during the cooldown");
    await clock.advance(1);
    assert.equal((await first).status, 200);
    assert.equal((await second).status, 200);
    assert.equal(calls.length, 3);
  });

  it("waits at least a second on 429 even when Retry-After is 0", async () => {
    const clock = new FakeClock();
    let n = 0;
    const { fetch, calls } = fakeFetch(() =>
      ++n === 1 ? json({}, 429, { "retry-after": "0" }) : json({ ok: true })
    );
    const request = new HttpClient({ clock, fetch }).get(
      "https://x.test/a",
      options
    );
    await clock.advance(999);
    assert.equal(calls.length, 1, "no instant replay");
    await clock.advance(1);
    assert.equal((await request).status, 200);
  });

  it("keeps waiting when the cooldown is extended while it sleeps", async () => {
    const clock = new FakeClock();
    const gate = new RateGate();
    gate.blockedUntilMs = clock.now() + 2_000;
    const { fetch, calls } = fakeFetch(() => json({ ok: true }));
    const request = new HttpClient({ clock, fetch }).get("https://x.test/a", {
      ...options,
      gate
    });
    await clock.advance(1_000);
    gate.blockedUntilMs = clock.now() + 3_000;
    await clock.advance(2_999);
    assert.equal(calls.length, 0, "the extension is honoured");
    await clock.advance(1);
    assert.equal((await request).status, 200);
  });

  it("fails fast when the cooldown is longer than it is willing to wait", async () => {
    const clock = new FakeClock();
    const gate = new RateGate();
    const { fetch, calls } = fakeFetch(() =>
      json({}, 429, { "retry-after": "600" })
    );
    const http = new HttpClient({ clock, fetch });
    await assert.rejects(
      http.get("https://x.test/a", { ...options, gate }),
      (e: unknown) => e instanceof HttpError && e.kind === "rate-limited"
    );
    await assert.rejects(
      http.get("https://x.test/a", { ...options, gate }),
      /rate limited/
    );
    assert.equal(
      calls.length,
      1,
      "the second request never reaches the provider"
    );
  });

  it("returns accepted non-200 statuses to the caller", async () => {
    const { fetch } = fakeFetch(() => json({}, 404));
    const response = await new HttpClient({
      clock: new FakeClock(),
      fetch
    }).get("https://x.test/a", {
      ...options,
      acceptStatuses: [200, 404]
    });
    assert.equal(response.status, 404);
  });

  it("reports network failures without stack traces", async () => {
    const { fetch } = fakeFetch(() => {
      throw new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } });
    });
    await assert.rejects(
      new HttpClient({ clock: new FakeClock(), fetch }).get(
        "https://x.test/a",
        { timeoutMs: 1000, retries: 0 }
      ),
      { message: "network error (ENOTFOUND)" }
    );
  });

  it("stops immediately when the client is shut down", async () => {
    const clock = new FakeClock();
    const shutdown = new AbortController();
    const { fetch } = fakeFetch(hang);
    const request = new HttpClient({
      clock,
      fetch,
      signal: shutdown.signal
    }).get("https://x.test/a", options);
    shutdown.abort();
    await assert.rejects(
      request,
      (e: unknown) => e instanceof HttpError && e.kind === "aborted"
    );
  });

  it("parses Retry-After seconds and HTTP dates", () => {
    const now = Date.UTC(2026, 9, 28, 10, 0, 0);
    assert.equal(parseRetryAfter("3", now), 3000);
    assert.equal(
      parseRetryAfter(new Date(now + 7000).toUTCString(), now),
      7000
    );
    assert.equal(parseRetryAfter("soon", now), undefined);
    assert.equal(parseRetryAfter(null, now), undefined);
  });
});

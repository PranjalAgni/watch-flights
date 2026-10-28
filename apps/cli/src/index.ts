#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  AdsbdbClient,
  AdsbLolClient,
  ConfigError,
  formatDateTime,
  FlightWatcher,
  HttpClient,
  MetadataService,
  POLL_INTERVAL_MS,
  PollScheduler,
  sleep,
  systemClock
} from "@watch-flights/core";
import { AircraftDbManager } from "./aircraft-db-manager.js";
import { loadConfig } from "./config-file.js";
import { MIN_WIDTH, renderFrame, type RenderInput } from "./display/render.js";
import { shouldUseColor } from "./display/style.js";
import { InteractiveScreen } from "./display/terminal.js";

// Resolves to apps/cli both from src/ (tsx) and from the bundled dist/.
const APP_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_CONFIG = resolve(APP_ROOT, "../../config/locations.json");
const CACHE_DIR = resolve(APP_ROOT, ".cache");
/**
 * How long redirected/--once output waits for owner lookups before printing
 * anyway.
 */
const ENRICHMENT_WAIT_MS = 20_000;

const HELP = `Nearby Flights - live ADS-B aircraft around your configured locations

Usage: nearby-flights [options]

Options:
  -c, --config <path>  Location registry (default: config/locations.json,
                       or $NEARBY_FLIGHTS_CONFIG)
      --once           Fetch once, print the result and exit
  -h, --help           Show this help

Polls every 5 minutes. Set NO_COLOR=1 to disable colour.`;

async function main(): Promise<void> {
  let args;
  try {
    args = parseArgs({
      options: {
        config: { type: "string", short: "c" },
        once: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false }
      }
    }).values;
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${HELP}\n`);
    process.exit(2);
  }
  if (args.help) {
    process.stdout.write(`${HELP}\n`);
    return;
  }

  const configPath = resolve(
    args.config ?? process.env.NEARBY_FLIGHTS_CONFIG ?? DEFAULT_CONFIG
  );
  let config;
  try {
    config = await loadConfig(configPath);
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }

  const stdout = process.stdout;
  const once = args.once;
  const interactive = Boolean(stdout.isTTY) && !once;
  const color = shouldUseColor(stdout, process.env);
  const clock = systemClock;
  const shutdown = new AbortController();
  const http = new HttpClient({
    clock,
    signal: shutdown.signal,
    userAgent: "nearby-flights/1.0"
  });
  const screen = new InteractiveScreen(stdout);
  let stopping = false;

  // Leave the alternate screen before reporting, or the message vanishes with
  // it.
  const fail = (error: unknown) => {
    screen.exit();
    process.stderr.write(
      `Nearby Flights stopped unexpectedly: ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exit(1);
  };
  // A closed pipe (e.g. `| head`) is a normal way for output to end.
  stdout.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") process.exit(0);
    fail(error);
  });
  process.on("uncaughtException", fail);
  process.on("unhandledRejection", fail);
  process.on("exit", () => screen.exit());

  let drawPending = false;
  const requestRender = (): void => {
    if (!interactive || drawPending) return;
    drawPending = true;
    setImmediate(() => {
      drawPending = false;
      draw();
    });
  };

  const aircraftDb = new AircraftDbManager({
    http,
    clock,
    cacheDir: CACHE_DIR,
    onChange: requestRender
  });
  const metadata = new MetadataService({
    clock,
    aircraftDb: () => aircraftDb.db,
    remote: new AdsbdbClient(http)
  });
  const watcher = new FlightWatcher({
    locations: config.locations,
    positions: new AdsbLolClient(http),
    metadata,
    clock,
    onUpdate: requestRender
  });

  const time = { timeZone: config.timeZone, label: config.timeZoneLabel };
  const renderInput = (nextRefreshAtMs: number | null): RenderInput => ({
    nowMs: clock.now(),
    states: watcher.states,
    resolve: (aircraft) => metadata.resolve(aircraft),
    nextRefreshAtMs,
    pollIntervalMs: POLL_INTERVAL_MS,
    aircraftDb: aircraftDb.status(),
    time
  });

  const outputWidth = () =>
    stdout.columns ?? (Number(process.env.COLUMNS) || 120);
  const dbReady = aircraftDb.init();
  let firstCycle = true;

  /** Plain output for pipes and --once: one complete frame per cycle. */
  async function printCycle(nextRefreshAtMs: number | null): Promise<void> {
    // The database download has its own timeout; let it finish so the cache
    // gets written.
    await dbReady;
    await Promise.race([
      watcher.enrichment,
      sleep(clock, ENRICHMENT_WAIT_MS, shutdown.signal).catch(() => {})
    ]);
    if (stopping) return;
    const frame = renderFrame(renderInput(nextRefreshAtMs), {
      width: outputWidth(),
      color,
      mode: once ? "once" : "log"
    });
    const stamp = `── ${formatDateTime(clock.now(), time)} `;
    stdout.write(
      `${stamp}${"─".repeat(Math.max(0, outputWidth() - 1 - stamp.length))}\n${frame}\n\n`
    );
  }

  if (once) {
    await watcher.runCycle();
    await printCycle(null);
    process.exitCode = watcher.states.every((s) => s.lastError) ? 1 : 0;
    // Cancels outstanding lookups so the process can exit once stdout has
    // drained.
    shutdown.abort();
    return;
  }

  const scheduler = new PollScheduler({
    clock,
    intervalMs: POLL_INTERVAL_MS,
    run: async () => {
      const startedAt = clock.now();
      if (!firstCycle) aircraftDb.refreshIfStale();
      firstCycle = false;
      await watcher.runCycle();
      if (!interactive) await printCycle(startedAt + POLL_INTERVAL_MS);
    },
    onScheduled: requestRender
  });

  function draw(): void {
    const width = stdout.columns ?? 100;
    const rows = stdout.rows ?? 40;
    if (width < MIN_WIDTH) {
      screen.draw(
        ` Terminal too narrow - widen to at least ${MIN_WIDTH} columns.`
      );
      return;
    }
    const input = renderInput(scheduler.nextRunAtMs);
    let frame = renderFrame(input, { width, color, mode: "live" });
    const most = Math.max(
      0,
      ...watcher.states.map((s) => s.lastSuccess?.aircraft.length ?? 0)
    );
    for (
      let max = most - 1;
      frame.split("\n").length > rows && max >= 1;
      max--
    ) {
      frame = renderFrame(input, {
        width,
        color,
        mode: "live",
        maxAircraftPerLocation: max
      });
    }
    // Never let the alternate screen scroll; that would break in-place redraws.
    screen.draw(frame.split("\n").slice(0, rows).join("\n"));
  }

  let ticker: NodeJS.Timeout | undefined;
  const stop = async (signal: NodeJS.Signals) => {
    if (stopping) process.exit(130);
    stopping = true;
    clearInterval(ticker);
    shutdown.abort();
    screen.exit();
    await scheduler.stop();
    const message =
      signal === "SIGINT" && interactive ? "Stopped Nearby Flights.\n" : "";
    stdout.write(message, () => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  if (interactive) {
    screen.enter();
    ticker = setInterval(draw, 1000);
    stdout.on("resize", () => {
      screen.invalidate();
      draw();
    });
    draw();
  }
  scheduler.start();
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Nearby Flights stopped unexpectedly: ${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exit(1);
});

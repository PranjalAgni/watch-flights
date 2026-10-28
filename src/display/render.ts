import Table from "cli-table3";
import type { AircraftDbStatus } from "../aircraft-db.js";
import type {
  AircraftMetadata,
  AircraftPosition,
  Airport,
  LocationState,
  RouteInfo
} from "../types.js";
import {
  formatAgo,
  formatAltitude,
  formatCountdown,
  formatDateTime,
  formatDirection,
  formatDistance,
  formatDuration,
  formatInteger,
  formatRadius,
  formatShortDate,
  formatSpeed,
  formatTime,
  type TimeFormat,
  UNKNOWN
} from "./format.js";
import {
  createStyle,
  stripAnsi,
  type Style,
  truncate,
  visibleLength
} from "./style.js";

export interface RenderInput {
  nowMs: number;
  states: readonly LocationState[];
  resolve: (aircraft: AircraftPosition) => AircraftMetadata;
  /** Null while a poll cycle is running. */
  nextRefreshAtMs: number | null;
  pollIntervalMs: number;
  aircraftDb: AircraftDbStatus;
  time: TimeFormat;
}

export interface RenderOptions {
  /**
   * Terminal columns. Lines are kept at least one column narrower so the last
   * column is never written.
   */
  width: number;
  color: boolean;
  /**
   * live: in-place refresh with countdown; log: one frame per cycle; once: a
   * single snapshot.
   */
  mode: "live" | "log" | "once";
  /** Caps table rows per location (nearest kept) so a frame fits the screen. */
  maxAircraftPerLocation?: number;
}

type ColumnKey =
  | "callsign"
  | "route"
  | "registration"
  | "model"
  | "owner"
  | "distance"
  | "bearing"
  | "altitude"
  | "speed"
  | "track"
  | "seen";

interface Column {
  key: ColumnKey;
  header: string;
  /** Used when the column is too narrow for the full header. */
  shortHeader?: string;
  align: "left" | "right";
  /** Truncatable columns shrink before primary columns are hidden. */
  maxWidth?: number;
}

const COLUMNS: readonly Column[] = [
  { key: "callsign", header: "Callsign", align: "left" },
  { key: "route", header: "Route", align: "left" },
  { key: "registration", header: "Reg", align: "left" },
  { key: "model", header: "Model", align: "left", maxWidth: 26 },
  {
    key: "owner",
    header: "Owner/Operator",
    shortHeader: "Owner",
    align: "left",
    maxWidth: 26
  },
  { key: "distance", header: "Dist", align: "right" },
  { key: "bearing", header: "Bearing", align: "right" },
  { key: "altitude", header: "Alt", align: "right" },
  { key: "speed", header: "Speed", align: "right" },
  { key: "track", header: "Track", align: "right" },
  { key: "seen", header: "Seen", align: "right" }
];

/**
 * Narrowing steps, applied in order until the table fits: hide secondary
 * columns while labels stay whole, then allow light truncation, then hide
 * speed, then tighter truncation (labels cut much shorter are unreadable), then
 * owner, route and finally model, so callsign, distance and altitude always fit
 * MIN_WIDTH.
 */
const LAYOUT_STEPS: readonly ({ drop: ColumnKey } | { minWidth: number })[] = [
  { drop: "track" },
  { drop: "seen" },
  { drop: "bearing" },
  { drop: "registration" },
  { minWidth: 14 },
  { drop: "speed" },
  { minWidth: 10 },
  { drop: "owner" },
  { drop: "route" },
  { minWidth: 6 },
  { drop: "model" }
];
const CELL_PADDING = 2;
/**
 * Positions already this old when fetched are flagged; age naturally grows
 * between polls.
 */
const STALE_AT_FETCH_MS = 60_000;
const MARGIN = " ";
/**
 * Appended to a published route that does not match the aircraft's position.
 */
const ROUTE_MISMATCH = "?";
/** Narrowest terminal the frame is designed for; see LAYOUT_STEPS. */
export const MIN_WIDTH = 40;

type Row = Record<ColumnKey, string>;

export function renderFrame(
  input: RenderInput,
  options: RenderOptions
): string {
  const style = createStyle(options.color);
  const width = Math.max(MIN_WIDTH, options.width);
  const lines: string[] = [];

  const limit = options.maxAircraftPerLocation ?? Infinity;
  const sections = input.states.map((state) => {
    const aircraft = state.lastSuccess?.aircraft.slice(0, limit) ?? [];
    return { state, aircraft, rows: aircraft.map((a) => buildRow(a, input)) };
  });
  // One layout for every table so columns line up across locations.
  const layout = chooseLayout(
    sections.flatMap((s) => s.rows),
    width - MARGIN.length - 1
  );

  lines.push(...renderTitle(input, width, style), "");
  for (const section of sections) {
    lines.push(...renderLocation(section, layout, input, width, style), "");
  }
  lines.push(
    ...renderFooter(
      input,
      options,
      layout,
      sections.flatMap((s) => s.rows),
      width,
      style
    )
  );
  return lines.join("\n");
}

function renderTitle(
  input: RenderInput,
  width: number,
  style: Style
): string[] {
  const minutes = Math.round(input.pollIntervalMs / 60_000);
  return [
    spread(
      style.bold(style.accent("✈ Nearby Flights")),
      style.dim(formatDateTime(input.nowMs, input.time)),
      width
    ),
    ...wrapSegments(
      ["Live ADS-B snapshots from ADSB.lol", `refreshed every ${minutes} min`],
      width - MARGIN.length - 1
    ).map((l) => MARGIN + style.dim(l))
  ];
}

interface Section {
  state: LocationState;
  aircraft: AircraftPosition[];
  rows: Row[];
}

function renderLocation(
  section: Section,
  layout: Layout,
  input: RenderInput,
  width: number,
  style: Style
): string[] {
  const { location, lastSuccess, lastError, fetching } = section.state;
  const snapshot = lastSuccess;
  const status = statusBadge(section.state, style);
  const name = truncate(
    location.name,
    Math.max(10, width - visibleLength(status) - 4)
  );
  const lines = [spread(style.bold(name), status, width)];

  const details = [formatRadius(location.radiusKm)];
  details.push(
    snapshot ? `${snapshot.aircraft.length} aircraft` : "aircraft count unknown"
  );
  details.push(
    snapshot
      ? `last success ${formatTime(snapshot.fetchedAtMs, input.time)} (${formatAgo(input.nowMs - snapshot.fetchedAtMs)})`
      : "no successful fetch yet"
  );
  lines.push(
    ...wrapSegments(details, width - MARGIN.length - 1).map(
      (l) => MARGIN + style.dim(l)
    )
  );

  if (lastError) {
    const when = formatTime(lastError.atMs, input.time);
    const message = snapshot
      ? `▲ Fetch failed at ${when}: ${lastError.message}. Showing the last successful snapshot.`
      : `✖ Fetch failed at ${when}: ${lastError.message}. No aircraft data yet.`;
    lines.push(
      ...wrapText(message, width - MARGIN.length - 1).map(
        (l) => MARGIN + (snapshot ? style.warn(l) : style.bad(l))
      )
    );
  }

  if (!snapshot) {
    if (fetching && !lastError)
      lines.push(MARGIN + style.dim("Fetching aircraft…"));
    return lines;
  }
  if (snapshot.aircraft.length === 0) {
    const empty = `ADSB.lol returned no airborne aircraft within ${location.radiusKm} km.`;
    lines.push(
      ...wrapText(empty, width - MARGIN.length - 1).map(
        (l) => MARGIN + style.dim(l)
      )
    );
    return lines;
  }

  const table = renderTable(
    section.rows,
    section.aircraft,
    layout,
    snapshot.fetchedAtMs,
    style
  );
  lines.push(...table.split("\n").map((l) => MARGIN + l));
  const hidden = snapshot.aircraft.length - section.aircraft.length;
  if (hidden > 0) {
    const more = `+ ${hidden} more aircraft farther away (enlarge the terminal to see all)`;
    lines.push(
      ...wrapText(more, width - MARGIN.length - 1).map(
        (l) => MARGIN + style.dim(l)
      )
    );
  }
  return lines;
}

function statusBadge(state: LocationState, style: Style): string {
  const updating = state.fetching ? style.dim(" · updating…") : "";
  if (state.lastError && state.lastSuccess)
    return style.warn("▲ STALE") + updating;
  if (state.lastError) return style.bad("✖ ERROR") + updating;
  if (state.lastSuccess) return style.good("● OK") + updating;
  return style.dim(state.fetching ? "◌ FETCHING" : "◌ WAITING");
}

function buildRow(aircraft: AircraftPosition, input: RenderInput): Row {
  const meta = input.resolve(aircraft);
  const owner = meta.owner?.value ?? meta.ownerOperator?.value ?? null;
  return {
    callsign: aircraft.callsign ?? UNKNOWN,
    route: formatRoute(meta.route),
    registration: meta.registration?.value ?? UNKNOWN,
    model: meta.model?.value ?? meta.typeCode?.value ?? UNKNOWN,
    owner: owner ?? UNKNOWN,
    distance: formatDistance(aircraft.distanceKm),
    bearing: formatDirection(aircraft.bearingDeg),
    altitude: formatAltitude(aircraft.altitude),
    speed: formatSpeed(aircraft.groundSpeedKmh),
    track: formatDirection(aircraft.trackDeg),
    seen:
      aircraft.positionAtMs === null
        ? UNKNOWN
        : formatDuration(input.nowMs - aircraft.positionAtMs)
  };
}

function formatRoute(route: RouteInfo | null): string {
  if (!route) return UNKNOWN;
  const code = (airport: Airport) => airport.iata ?? airport.icao ?? UNKNOWN;
  const text = `${code(route.value.origin)}→${code(route.value.destination)}`;
  return route.check === "inconsistent" ? text + ROUTE_MISMATCH : text;
}

export interface Layout {
  columns: Column[];
  widths: number[];
}

export function chooseLayout(rows: readonly Row[], width: number): Layout {
  const natural = (column: Column) =>
    Math.max(
      visibleLength(column.header),
      ...rows.map((row) => visibleLength(row[column.key]))
    ) + CELL_PADDING;
  const narrowest = (column: Column) =>
    visibleLength(column.shortHeader ?? column.header) + CELL_PADDING;
  const attempt = (dropped: ReadonlySet<ColumnKey>, minWidth: number) => {
    const columns = COLUMNS.filter((c) => !dropped.has(c.key));
    const widths = columns.map((c) =>
      c.maxWidth ? Math.min(natural(c), c.maxWidth + CELL_PADDING) : natural(c)
    );
    const available = width - (columns.length + 1);
    let overflow = widths.reduce((a, b) => a + b, 0) - available;
    // Shrink the widest truncatable column one character at a time.
    while (overflow > 0) {
      let widest = -1;
      columns.forEach((c, i) => {
        if (
          c.maxWidth &&
          widths[i]! > Math.max(minWidth + CELL_PADDING, narrowest(c)) &&
          (widest === -1 || widths[i]! > widths[widest]!)
        )
          widest = i;
      });
      if (widest === -1) break;
      widths[widest]!--;
      overflow--;
    }
    return overflow <= 0 ? { columns, widths } : null;
  };

  const dropped = new Set<ColumnKey>();
  let minWidth = Infinity; // No truncation beyond each column's maxWidth.
  let layout = attempt(dropped, minWidth);
  for (const step of LAYOUT_STEPS) {
    if (layout) return layout;
    if ("drop" in step) dropped.add(step.drop);
    else minWidth = step.minWidth;
    layout = attempt(dropped, minWidth);
  }
  if (layout) return layout;
  const columns = COLUMNS.filter((c) => !dropped.has(c.key));
  return { columns, widths: columns.map(natural) };
}

function renderTable(
  rows: readonly Row[],
  aircraft: readonly AircraftPosition[],
  layout: Layout,
  fetchedAtMs: number,
  style: Style
): string {
  const { columns, widths } = layout;
  const table = new Table({
    head: columns.map((c, i) => {
      const room = widths[i]! - CELL_PADDING;
      const header =
        c.header.length > room && c.shortHeader ? c.shortHeader : c.header;
      return style.accent(truncate(header, room));
    }),
    colWidths: widths,
    colAligns: columns.map((c) => c.align),
    wordWrap: false,
    truncate: "…",
    style: { head: [], border: [], "padding-left": 1, "padding-right": 1 },
    chars: borderChars(style)
  });
  rows.forEach((row, index) => {
    const position = aircraft[index]!;
    table.push(
      columns.map((column, i) => {
        const value = truncate(row[column.key], widths[i]! - CELL_PADDING);
        if (row[column.key] === UNKNOWN) return style.dim(value);
        if (column.key === "callsign") return style.bold(value);
        if (column.key === "route" && row.route.endsWith(ROUTE_MISMATCH))
          return style.warn(value);
        if (
          column.key === "seen" &&
          position.positionAtMs !== null &&
          fetchedAtMs - position.positionAtMs > STALE_AT_FETCH_MS
        ) {
          return style.warn(value);
        }
        return value;
      })
    );
  });
  // Rows are single-line, so every separator after the first (header) one is
  // noise.
  let seenHeaderRule = false;
  return table
    .toString()
    .split("\n")
    .filter((line) => {
      if (!stripAnsi(line).startsWith("├")) return true;
      if (seenHeaderRule) return false;
      seenHeaderRule = true;
      return true;
    })
    .join("\n");
}

function borderChars(style: Style): Partial<Record<Table.CharName, string>> {
  const chars: Record<Table.CharName, string> = {
    top: "─",
    "top-mid": "┬",
    "top-left": "┌",
    "top-right": "┐",
    bottom: "─",
    "bottom-mid": "┴",
    "bottom-left": "└",
    "bottom-right": "┘",
    left: "│",
    "left-mid": "├",
    mid: "─",
    "mid-mid": "┼",
    right: "│",
    "right-mid": "┤",
    middle: "│"
  };
  for (const key of Object.keys(chars) as Table.CharName[]) {
    if (chars[key]) chars[key] = style.dim(chars[key]);
  }
  return chars;
}

function renderFooter(
  input: RenderInput,
  options: RenderOptions,
  layout: Layout,
  rows: readonly Row[],
  width: number,
  style: Style
): string[] {
  const lines: string[] = [];
  let refresh: string;
  if (options.mode === "once")
    refresh = "Single snapshot (--once); run without --once to keep refreshing";
  else if (input.nextRefreshAtMs === null) refresh = "Refreshing now…";
  else if (options.mode === "live") {
    refresh = `Next refresh ${formatTime(input.nextRefreshAtMs, input.time)} · in ${formatCountdown(input.nextRefreshAtMs - input.nowMs)}`;
  } else
    refresh = `Next refresh ${formatTime(input.nextRefreshAtMs, input.time)}`;
  if (options.mode === "live")
    lines.push(
      spread(style.accent(refresh), style.dim("Ctrl-C to quit"), width)
    );
  else
    lines.push(
      ...wrapText(refresh, width - MARGIN.length - 1).map(
        (l) => MARGIN + style.accent(l)
      )
    );

  const db = input.aircraftDb;
  let dbText: string;
  if (db.state === "ready") {
    dbText = `Aircraft DB: ${formatInteger(db.records)} records, updated ${db.updatedAtMs === null ? UNKNOWN : formatShortDate(db.updatedAtMs, input.time)}`;
    if (db.refreshing) dbText += " (refreshing…)";
    else if (db.lastError) dbText += " (refresh failed, using cached copy)";
    else if (db.cacheError) dbText += " (could not save to disk)";
  } else if (db.state === "loading") dbText = "Aircraft DB: downloading…";
  else
    dbText = `Aircraft DB: unavailable (${db.lastError ?? UNKNOWN}); models and registrations may be missing`;
  lines.push(
    ...wrapSegments(
      [dbText, "Metadata: tar1090-db, ADSBdb"],
      width - MARGIN.length - 1
    ).map((l) => MARGIN + style.dim(l))
  );
  const routes = [`Routes: ADSBdb, published per callsign, not confirmed`];
  if (
    layout.columns.some((c) => c.key === "route") &&
    rows.some((r) => r.route.endsWith(ROUTE_MISMATCH))
  ) {
    routes.push(`${ROUTE_MISMATCH} = does not match the aircraft's position`);
  }
  lines.push(
    ...wrapSegments(routes, width - MARGIN.length - 1).map(
      (l) => MARGIN + style.dim(l)
    )
  );
  lines.push(
    ...wrapText(
      "Snapshots only: aircraft passing between polls may be missed.",
      width - MARGIN.length - 1
    ).map((l) => MARGIN + style.dim(l))
  );
  return lines;
}

/**
 * Left text with right text aligned to the terminal edge, or on its own line
 * when both do not fit.
 */
function spread(left: string, right: string, width: number): string {
  const gap =
    width - MARGIN.length - visibleLength(left) - visibleLength(right) - 1;
  return gap >= 2
    ? `${MARGIN}${left}${" ".repeat(gap)}${right}`
    : `${MARGIN}${left}\n${MARGIN}${right}`;
}

function wrapText(text: string, width: number): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (current && visibleLength(current) + 1 + visibleLength(word) > width) {
      lines.push(current);
      current = word;
    } else current = current ? `${current} ${word}` : word;
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * Joins segments with " · ", breaking lines only between segments (long
 * segments are word-wrapped).
 */
function wrapSegments(segments: readonly string[], width: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const segment of segments) {
    const joined = current ? `${current} · ${segment}` : segment;
    if (visibleLength(joined) <= width) {
      current = joined;
      continue;
    }
    if (current) lines.push(current);
    const pieces = wrapText(segment, width);
    current = pieces.pop() ?? "";
    lines.push(...pieces);
  }
  if (current) lines.push(current);
  return lines;
}

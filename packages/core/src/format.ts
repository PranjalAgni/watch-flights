import { compassPoint } from "./geo.js";
import type { Altitude } from "./types.js";

export const UNKNOWN = "unknown";

export interface TimeFormat {
  timeZone: string;
  label: string;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string, withDate: boolean): Intl.DateTimeFormat {
  const key = `${timeZone}|${withDate}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hourCycle: "h23",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      ...(withDate ? { day: "numeric", month: "short", year: "numeric" } : {})
    });
    formatters.set(key, f);
  }
  return f;
}

export function formatTime(ms: number, tf: TimeFormat): string {
  return `${formatter(tf.timeZone, false).format(ms)} ${tf.label}`;
}

export function formatDateTime(ms: number, tf: TimeFormat): string {
  return `${formatter(tf.timeZone, true).format(ms).replace(" at ", ", ")} ${tf.label}`;
}

export function formatShortDate(ms: number, tf: TimeFormat): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tf.timeZone,
    day: "numeric",
    month: "short"
  }).format(ms);
}

export function formatAgo(ms: number): string {
  if (ms < 5_000) return "just now";
  return `${formatDuration(ms)} ago`;
}

/** Compact duration: "42s", "3m 05s", "2h 07m". */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60)
    return `${minutes}m ${String(totalSeconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export function formatCountdown(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

export function formatInteger(value: number): string {
  return integer.format(value);
}

export function formatAltitude(altitude: Altitude | null): string {
  if (!altitude) return UNKNOWN;
  return altitude.kind === "ground"
    ? "ground"
    : `${integer.format(altitude.feet)} ft`;
}

export function formatSpeed(kmh: number | null): string {
  return kmh === null ? UNKNOWN : `${integer.format(kmh)} km/h`;
}

export function formatDistance(km: number | null): string {
  return km === null ? UNKNOWN : `${km.toFixed(1)} km`;
}

export function formatDirection(deg: number | null): string {
  return deg === null
    ? UNKNOWN
    : `${String(Math.round(deg) % 360).padStart(3, "0")}° ${compassPoint(deg)}`;
}

export function formatRadius(km: number): string {
  return `${Number.isInteger(km) ? km : km.toFixed(1)} km radius`;
}

import {
  type AppConfig,
  parseConfig,
  type TimeFormat
} from "@watch-flights/core";
import raw from "../../../config/locations.json";

/** The shared registry, bundled at build time. */
export const config: AppConfig = parseConfig(raw, "config/locations.json");

export const time: TimeFormat = {
  timeZone: config.timeZone,
  label: config.timeZoneLabel
};

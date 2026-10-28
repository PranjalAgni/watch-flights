import {
  type AircraftMetadata,
  type AircraftPosition,
  formatAgo,
  formatRadius,
  formatTime,
  type LocationState
} from "@watch-flights/core";
import { Fragment } from "react";
import { StyleSheet, Text, View } from "react-native";
import { time } from "../config";
import { colors, radius, space } from "../theme";
import { AircraftRow } from "./AircraftRow";
import { StatusPill } from "./StatusPill";

interface Props {
  state: LocationState;
  nowMs: number;
  resolve: (aircraft: AircraftPosition) => AircraftMetadata;
  expanded: ReadonlySet<string>;
  onToggle: (key: string) => void;
}

function summary(state: LocationState, nowMs: number): string {
  const parts = [formatRadius(state.location.radiusKm)];
  const snapshot = state.lastSuccess;
  if (snapshot) {
    const count = snapshot.aircraft.length;
    parts.push(`${count} aircraft`);
    parts.push(
      `${formatTime(snapshot.fetchedAtMs, time)} (${formatAgo(nowMs - snapshot.fetchedAtMs)})`
    );
  } else if (state.lastError) {
    parts.push("aircraft count unknown");
  }
  return parts.join(" · ");
}

export function LocationSection({
  state,
  nowMs,
  resolve,
  expanded,
  onToggle
}: Props) {
  const snapshot = state.lastSuccess;
  const id = state.location.id;
  return (
    <View style={styles.section}>
      <View style={styles.header}>
        <Text style={styles.name} numberOfLines={2}>
          {state.location.name}
        </Text>
        <StatusPill state={state} />
      </View>
      <Text style={styles.summary}>{summary(state, nowMs)}</Text>
      {state.lastError ? (
        <Text style={styles.error}>
          {snapshot ? "Showing the last good snapshot. " : ""}
          Failed at {formatTime(state.lastError.atMs, time)}:{" "}
          {state.lastError.message}
        </Text>
      ) : null}

      {snapshot && snapshot.aircraft.length > 0 ? (
        <View style={styles.card}>
          {snapshot.aircraft.map((aircraft, index) => {
            const key = `${id}:${aircraft.hex}`;
            return (
              <Fragment key={aircraft.hex}>
                {index > 0 ? <View style={styles.separator} /> : null}
                <AircraftRow
                  aircraft={aircraft}
                  metadata={resolve(aircraft)}
                  nowMs={nowMs}
                  expanded={expanded.has(key)}
                  onToggle={() => onToggle(key)}
                />
              </Fragment>
            );
          })}
        </View>
      ) : snapshot ? (
        <View style={[styles.card, styles.empty]}>
          <Text style={styles.emptyText}>
            No airborne aircraft reported in the{" "}
            {formatRadius(state.location.radiusKm)}.
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginTop: space.xl, paddingHorizontal: space.lg },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.md
  },
  name: { flex: 1, color: colors.text, fontSize: 20, fontWeight: "700" },
  summary: {
    marginTop: 3,
    color: colors.secondary,
    fontSize: 13,
    fontVariant: ["tabular-nums"]
  },
  error: { marginTop: space.xs, color: colors.warning, fontSize: 13 },
  card: {
    marginTop: space.md,
    backgroundColor: colors.card,
    borderRadius: radius.card,
    borderCurve: "continuous",
    overflow: "hidden"
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.separator,
    marginLeft: space.lg
  },
  empty: { paddingHorizontal: space.lg, paddingVertical: space.lg },
  emptyText: { color: colors.secondary, fontSize: 14 }
});

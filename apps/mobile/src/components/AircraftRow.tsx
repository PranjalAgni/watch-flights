import {
  type AircraftMetadata,
  type AircraftPosition,
  type Airport,
  formatAgo,
  formatAltitude,
  formatDirection,
  formatDistance,
  formatSpeed,
  type RouteInfo
} from "@watch-flights/core";
import { SymbolView } from "expo-symbols";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors, space } from "../theme";

interface Props {
  aircraft: AircraftPosition;
  metadata: AircraftMetadata;
  nowMs: number;
  expanded: boolean;
  onToggle: () => void;
}

const code = (airport: Airport) => airport.iata ?? airport.icao ?? "?";

function airportLabel(airport: Airport): string {
  const name = airport.name ?? code(airport);
  return airport.municipality && !name.includes(airport.municipality)
    ? `${name}, ${airport.municipality}`
    : name;
}

function Route({ route }: { route: RouteInfo | null }) {
  if (!route) return null;
  const mismatch = route.check === "inconsistent";
  return (
    <Text
      style={[styles.route, mismatch && styles.routeMismatch]}
      numberOfLines={1}
    >
      {code(route.value.origin)} → {code(route.value.destination)}
      {mismatch ? " ?" : ""}
    </Text>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.detail}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={styles.detailValue}>{value}</Text>
    </View>
  );
}

export function AircraftRow({
  aircraft,
  metadata,
  nowMs,
  expanded,
  onToggle
}: Props) {
  const registration = metadata.registration?.value ?? null;
  const title = aircraft.callsign ?? registration ?? aircraft.hex.toUpperCase();
  // Without tar1090-db the model is often unknown; the ICAO type code is not.
  const model = metadata.model?.value ?? metadata.typeCode?.value;
  const subtitle = [model, registration].filter(Boolean).join(" · ");
  const owner = metadata.owner?.value ?? metadata.ownerOperator?.value ?? null;
  const route = metadata.route;

  return (
    <Pressable
      onPress={onToggle}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      accessibilityRole="button"
      accessibilityState={{ expanded }}
    >
      <View style={styles.main}>
        <View style={styles.left}>
          <View style={styles.titleLine}>
            <Text
              style={[styles.title, !aircraft.callsign && styles.titleMuted]}
              numberOfLines={1}
            >
              {title}
            </Text>
            <Route route={route} />
          </View>
          {subtitle ? (
            <Text style={styles.subtitle} numberOfLines={1}>
              {subtitle}
            </Text>
          ) : null}
          {owner ? (
            <Text style={styles.owner} numberOfLines={1}>
              {owner}
            </Text>
          ) : null}
        </View>
        <View style={styles.right}>
          <View style={styles.distanceLine}>
            {aircraft.bearingDeg !== null ? (
              <SymbolView
                name="location.north.fill"
                size={11}
                tintColor={colors.accent}
                style={[
                  styles.arrow,
                  { transform: [{ rotate: `${aircraft.bearingDeg}deg` }] }
                ]}
              />
            ) : null}
            <Text style={styles.distance}>
              {formatDistance(aircraft.distanceKm)}
            </Text>
          </View>
          <Text style={styles.altitude}>
            {formatAltitude(aircraft.altitude)}
          </Text>
        </View>
      </View>

      {expanded ? (
        <View style={styles.details}>
          {route ? (
            <>
              <Detail label="From" value={airportLabel(route.value.origin)} />
              <Detail
                label="To"
                value={airportLabel(route.value.destination)}
              />
              {route.check === "inconsistent" ? (
                <Text style={styles.warning}>
                  The route published for {route.value.callsign} does not match
                  where this aircraft is, so it may belong to another flight.
                </Text>
              ) : null}
            </>
          ) : null}
          <Detail
            label="Bearing"
            value={formatDirection(aircraft.bearingDeg)}
          />
          <Detail label="Heading" value={formatDirection(aircraft.trackDeg)} />
          <Detail label="Speed" value={formatSpeed(aircraft.groundSpeedKmh)} />
          <Detail
            label="Seen"
            value={
              aircraft.positionAtMs === null
                ? "unknown"
                : formatAgo(nowMs - aircraft.positionAtMs)
            }
          />
          <Detail
            label="ICAO"
            value={[aircraft.hex.toUpperCase(), metadata.typeCode?.value]
              .filter(Boolean)
              .join(" · ")}
          />
        </View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { paddingHorizontal: space.lg, paddingVertical: space.md },
  pressed: { backgroundColor: colors.cardPressed },
  main: { flexDirection: "row", alignItems: "flex-start", gap: space.md },
  left: { flex: 1, minWidth: 0, gap: 3 },
  titleLine: { flexDirection: "row", alignItems: "baseline", gap: space.sm },
  title: {
    color: colors.text,
    fontSize: 17,
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
    flexShrink: 0
  },
  titleMuted: { color: colors.secondary },
  route: {
    color: colors.accent,
    fontSize: 15,
    fontWeight: "500",
    flexShrink: 1
  },
  routeMismatch: { color: colors.warning },
  subtitle: { color: colors.secondary, fontSize: 14 },
  owner: { color: colors.muted, fontSize: 13 },
  right: { alignItems: "flex-end", gap: 3 },
  distanceLine: { flexDirection: "row", alignItems: "center", gap: 5 },
  arrow: { width: 11, height: 11 },
  distance: {
    color: colors.text,
    fontSize: 15,
    fontWeight: "500",
    fontVariant: ["tabular-nums"]
  },
  altitude: {
    color: colors.secondary,
    fontSize: 14,
    fontVariant: ["tabular-nums"]
  },
  details: {
    marginTop: space.md,
    paddingTop: space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.separator,
    gap: 6
  },
  detail: { flexDirection: "row", gap: space.md },
  detailLabel: { color: colors.tertiary, fontSize: 13, width: 64 },
  detailValue: {
    color: colors.text,
    fontSize: 13,
    flex: 1,
    fontVariant: ["tabular-nums"]
  },
  warning: { color: colors.warning, fontSize: 13, lineHeight: 18 }
});

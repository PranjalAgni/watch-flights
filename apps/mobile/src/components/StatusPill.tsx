import type { LocationState } from "@watch-flights/core";
import { useEffect, useState } from "react";
import { Animated, StyleSheet, Text, View } from "react-native";
import { colors, radius, space } from "../theme";

type Status = "loading" | "updating" | "live" | "stale" | "error";

const LOOK: Record<Status, { label: string; color: string }> = {
  loading: { label: "Loading", color: colors.secondary },
  updating: { label: "Updating", color: colors.accent },
  live: { label: "Live", color: colors.live },
  stale: { label: "Stale", color: colors.warning },
  error: { label: "Error", color: colors.error }
};

export function statusOf(state: LocationState): Status {
  if (state.fetching) return state.lastSuccess ? "updating" : "loading";
  if (state.lastError) return state.lastSuccess ? "stale" : "error";
  return "live";
}

/** The dot pulses while a request is in flight. */
function Dot({ color, pulsing }: { color: string; pulsing: boolean }) {
  const [opacity] = useState(() => new Animated.Value(1));
  useEffect(() => {
    if (!pulsing) {
      opacity.setValue(1);
      return;
    }
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: 0.25,
          duration: 600,
          useNativeDriver: true
        }),
        Animated.timing(opacity, {
          toValue: 1,
          duration: 600,
          useNativeDriver: true
        })
      ])
    );
    pulse.start();
    return () => pulse.stop();
  }, [opacity, pulsing]);
  return (
    <Animated.View style={[styles.dot, { backgroundColor: color, opacity }]} />
  );
}

export function StatusPill({ state }: { state: LocationState }) {
  const status = statusOf(state);
  const { label, color } = LOOK[status];
  return (
    <View style={[styles.pill, { borderColor: `${color}55` }]}>
      <Dot
        color={color}
        pulsing={status === "loading" || status === "updating"}
      />
      <Text style={[styles.label, { color }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: space.sm + 2,
    paddingVertical: 3,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth * 2
  },
  dot: { width: 7, height: 7, borderRadius: 3.5 },
  label: { fontSize: 12, fontWeight: "600", letterSpacing: 0.2 }
});

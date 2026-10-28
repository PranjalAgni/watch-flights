import { formatCountdown, formatTime } from "@watch-flights/core";
import * as Haptics from "expo-haptics";
import { StatusBar } from "expo-status-bar";
import { SymbolView } from "expo-symbols";
import { useCallback, useState } from "react";
import {
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View
} from "react-native";
import {
  SafeAreaProvider,
  useSafeAreaInsets
} from "react-native-safe-area-context";
import { LocationSection } from "./components/LocationSection";
import { LocationsSheet } from "./components/LocationsSheet";
import { config, time } from "./config";
import { useLocationPreferences } from "./preferences";
import { colors, space } from "./theme";
import { tracker, useFlightTracker, useNow } from "./tracker";

export default function App() {
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <Home />
    </SafeAreaProvider>
  );
}

function Home() {
  const insets = useSafeAreaInsets();
  const { locations, setEnabled } = useLocationPreferences(config.locations);
  const view = useFlightTracker(locations);
  const nowMs = useNow();
  const [pulling, setPulling] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  const onRefresh = useCallback(async () => {
    setPulling(true);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    try {
      await tracker.refresh();
    } finally {
      setPulling(false);
    }
  }, []);

  const toggle = useCallback((key: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }, []);

  const status =
    view.nextRefreshAtMs === null
      ? "Refreshing…"
      : `Next refresh in ${formatCountdown(view.nextRefreshAtMs - nowMs)}`;
  const updated =
    view.lastUpdatedAtMs === null
      ? null
      : `Updated ${formatTime(view.lastUpdatedAtMs, time)}`;

  return (
    <View style={styles.screen}>
      <ScrollView
        contentContainerStyle={{
          paddingTop: insets.top + space.sm,
          paddingBottom: insets.bottom + space.xl
        }}
        refreshControl={
          <RefreshControl
            refreshing={pulling}
            onRefresh={onRefresh}
            tintColor={colors.secondary}
          />
        }
      >
        <View style={styles.header}>
          <View style={styles.headerText}>
            <Text style={styles.title}>Nearby Flights</Text>
            <Text style={styles.status}>
              {updated ? `${updated} · ` : ""}
              {status}
            </Text>
          </View>
          <Pressable
            onPress={() => setSheetOpen(true)}
            hitSlop={10}
            style={({ pressed }) => [styles.button, pressed && styles.pressed]}
            accessibilityRole="button"
            accessibilityLabel="Choose locations"
          >
            <SymbolView
              name="slider.horizontal.3"
              size={18}
              tintColor={colors.accent}
              weight="semibold"
            />
          </Pressable>
        </View>

        {view.states.length === 0 ? (
          <Text style={styles.none}>
            No locations selected. Tap the button above to choose some.
          </Text>
        ) : (
          view.states.map((state) => (
            <LocationSection
              key={state.location.id}
              state={state}
              nowMs={nowMs}
              resolve={tracker.resolve}
              expanded={expanded}
              onToggle={toggle}
            />
          ))
        )}

        <View style={styles.footer}>
          <Text style={styles.footnote}>
            Positions from ADSB.lol, refreshed every 5 minutes. Aircraft passing
            between snapshots can be missed.
          </Text>
          <Text style={styles.footnote}>
            Owners and routes from ADSBdb. Routes are published per callsign and
            can be wrong; <Text style={styles.mismatch}>?</Text> marks one that
            does not match the aircraft&apos;s position. Tap an aircraft for
            details.
          </Text>
        </View>
      </ScrollView>

      <LocationsSheet
        visible={sheetOpen}
        locations={locations}
        onChange={setEnabled}
        onClose={() => setSheetOpen(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingTop: space.sm
  },
  headerText: { flex: 1, gap: 2 },
  title: {
    color: colors.text,
    fontSize: 34,
    fontWeight: "700",
    letterSpacing: 0.4
  },
  status: {
    color: colors.secondary,
    fontSize: 14,
    fontVariant: ["tabular-nums"]
  },
  button: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.card
  },
  pressed: { opacity: 0.6 },
  none: {
    marginTop: space.xl,
    marginHorizontal: space.lg,
    color: colors.secondary,
    fontSize: 15
  },
  footer: {
    marginTop: space.xl,
    marginHorizontal: space.lg + space.xs,
    gap: space.sm
  },
  footnote: { color: colors.tertiary, fontSize: 12, lineHeight: 17 },
  mismatch: { color: colors.warning, fontWeight: "700" }
});

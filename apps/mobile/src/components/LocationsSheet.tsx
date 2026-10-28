import { formatRadius, type Location } from "@watch-flights/core";
import { Fragment } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View
} from "react-native";
import { colors, radius, space } from "../theme";

interface Props {
  visible: boolean;
  locations: readonly Location[];
  onChange: (id: string, enabled: boolean) => void;
  onClose: () => void;
}

export function LocationsSheet({
  visible,
  locations,
  onChange,
  onClose
}: Props) {
  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={styles.sheet}>
        <View style={styles.bar}>
          <Text style={styles.title}>Locations</Text>
          <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button">
            <Text style={styles.done}>Done</Text>
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.content}>
          <View style={styles.card}>
            {locations.map((location, index) => (
              <Fragment key={location.id}>
                {index > 0 ? <View style={styles.separator} /> : null}
                <View style={styles.row}>
                  <View style={styles.text}>
                    <Text style={styles.name}>{location.name}</Text>
                    <Text style={styles.detail}>
                      {formatRadius(location.radiusKm)} ·{" "}
                      {location.latitude.toFixed(4)},{" "}
                      {location.longitude.toFixed(4)}
                    </Text>
                  </View>
                  <Switch
                    value={location.enabled}
                    onValueChange={(enabled) => onChange(location.id, enabled)}
                    trackColor={{ true: colors.live }}
                  />
                </View>
              </Fragment>
            ))}
          </View>
          <Text style={styles.footnote}>
            Locations come from config/locations.json in the repository. Choices
            here are saved on this device.
          </Text>
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  sheet: { flex: 1, backgroundColor: colors.background },
  bar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: space.lg,
    paddingTop: space.lg + 4,
    paddingBottom: space.md
  },
  title: { color: colors.text, fontSize: 17, fontWeight: "600" },
  done: { color: colors.accent, fontSize: 17, fontWeight: "600" },
  content: { padding: space.lg, paddingTop: space.sm },
  card: {
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
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md
  },
  text: { flex: 1, gap: 2 },
  name: { color: colors.text, fontSize: 16 },
  detail: {
    color: colors.secondary,
    fontSize: 13,
    fontVariant: ["tabular-nums"]
  },
  footnote: {
    marginTop: space.md,
    marginHorizontal: space.lg,
    color: colors.tertiary,
    fontSize: 13,
    lineHeight: 18
  }
});

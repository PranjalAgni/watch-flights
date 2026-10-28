import type { Location } from "@watch-flights/core";
import Storage from "expo-sqlite/kv-store";
import { useCallback, useMemo, useState } from "react";

const KEY = "enabled-locations";

type Overrides = Record<string, boolean>;

function load(): Overrides {
  try {
    const parsed: unknown = JSON.parse(Storage.getItemSync(KEY) ?? "{}");
    if (typeof parsed !== "object" || parsed === null) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, boolean] => typeof entry[1] === "boolean"
      )
    );
  } catch {
    return {};
  }
}

/**
 * Which locations to watch. The registry's `enabled` flag is the default; the
 * user's choices on this device override it.
 */
export function useLocationPreferences(registry: readonly Location[]) {
  const [overrides, setOverrides] = useState(load);

  const locations = useMemo(
    () =>
      registry.map((location) => ({
        ...location,
        enabled: overrides[location.id] ?? location.enabled
      })),
    [registry, overrides]
  );

  const setEnabled = useCallback((id: string, enabled: boolean) => {
    setOverrides((current) => {
      const next = { ...current, [id]: enabled };
      Storage.setItemSync(KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  return { locations, setEnabled };
}

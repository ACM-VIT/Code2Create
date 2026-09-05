import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";

import { describeError } from "./errors";

/** Read the OS again on focus/resume, without letting an older read undo a grant. */
export function useDeviceCheck<T>(
  read: () => Promise<T>,
  failureMessage: string,
) {
  const [value, setValue] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const generation = useRef(0);
  const requesting = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current += 1;
    };
  }, []);

  const inspect = useCallback(
    async (operation: () => Promise<T>) => {
      const current = ++generation.current;
      try {
        const next = await operation();
        if (mounted.current && current === generation.current) {
          setValue(next);
          setError(null);
        }
      } catch (caught) {
        if (mounted.current && current === generation.current) {
          setValue(null);
          setError(describeError(caught, failureMessage));
        }
      }
    },
    [failureMessage],
  );

  const refresh = useCallback(async () => {
    if (!requesting.current) await inspect(read);
  }, [inspect, read]);

  const request = useCallback(
    async (operation: () => Promise<T>) => {
      if (requesting.current) return;
      requesting.current = true;
      try {
        await inspect(operation);
      } finally {
        requesting.current = false;
      }
    },
    [inspect],
  );

  useFocusEffect(
    useCallback(() => {
      void refresh();
      const subscription = AppState.addEventListener("change", (state) => {
        if (state === "active") void refresh();
      });
      return () => subscription.remove();
    }, [refresh]),
  );

  return { value, error, refresh, request };
}

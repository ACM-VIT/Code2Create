import { api } from "@code2create/backend/api";
import { useQuery } from "convex/react";
import * as Location from "expo-location";
import { useEffect, useState } from "react";
import { AppState } from "react-native";
import {
  loadVenueTracking,
  readVenueTrackingIssue,
  stopNativeVenueTracking,
  subscribeToForegroundVenueChecks,
  venueLocationTask,
} from "./venue-location";

export function useReviewerVenue(
  eventSlug: string,
  enabled: boolean,
  installationId: string | null,
  ownerId: string | null,
) {
  const state = useQuery(
    api.reviewerVenue.mine,
    enabled && installationId ? { eventSlug, installationId } : "skip",
  );
  const [issue, setIssue] = useState<string | null>(null);
  const [backgroundEnabled, setBackgroundEnabled] = useState(false);
  const [foregroundGranted, setForegroundGranted] = useState(false);
  const [backgroundGranted, setBackgroundGranted] = useState(false);
  const [localEnabled, setLocalEnabled] = useState(false);
  const [revision, setRevision] = useState(0);
  const generation = state?.presence?.trackingGeneration;
  const policyVersion = state?.policy?.version;
  const monitoring = state?.presence?.monitoringEnabled;
  const onThisDevice = state?.trackingOnThisDevice;
  const loaded = state !== undefined;

  useEffect(() => {
    if (!loaded) return;
    let active = true;
    let inspection = 0;
    const inspect = async () => {
      const currentInspection = ++inspection;
      try {
        const record = await loadVenueTracking();
        if (!active || currentInspection !== inspection) return;
        const sameOwner =
          record?.ownerId === ownerId &&
          record?.installationId === installationId &&
          record?.eventSlug === eventSlug;
        // A successful HTTP mutation can precede its reactive query update.
        const awaitingSubscription =
          sameOwner && record !== null && record.generation > (generation ?? 0);
        const valid =
          record !== null &&
          sameOwner &&
          record.policyVersion === policyVersion &&
          (awaitingSubscription ||
            (record.generation === generation && monitoring && onThisDevice)) &&
          Date.now() < record.endsAt;
        if (record && !valid) {
          await stopNativeVenueTracking(record);
        }
        const [foreground, background] = await Promise.all([
          Location.getForegroundPermissionsAsync(),
          Location.getBackgroundPermissionsAsync(),
        ]);
        const started =
          await Location.hasStartedLocationUpdatesAsync(venueLocationTask);
        const savedIssue = await readVenueTrackingIssue();
        if (active && currentInspection === inspection) {
          setForegroundGranted(foreground.granted);
          setBackgroundGranted(background.granted);
          setLocalEnabled(Boolean(valid) && foreground.granted);
          setBackgroundEnabled(Boolean(valid) && foreground.granted && background.granted && started);
          if (savedIssue) setIssue(savedIssue);
        }
      } catch {
        if (active && currentInspection === inspection)
          setIssue(
            "Check location permissions in Settings, then reconnect venue checks.",
          );
      }
    };
    void inspect();
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active") void inspect();
    });
    return () => {
      active = false;
      subscription.remove();
    };
  }, [
    eventSlug,
    generation,
    installationId,
    loaded,
    monitoring,
    onThisDevice,
    ownerId,
    policyVersion,
    revision,
  ]);

  useEffect(() => {
    if (!enabled || !ownerId) return;
    return subscribeToForegroundVenueChecks(ownerId, setIssue);
  }, [enabled, ownerId]);

  return {
    state,
    issue,
    backgroundEnabled,
    foregroundGranted,
    backgroundGranted,
    localEnabled,
    installationId,
    ownerId,
    refresh: () => setRevision((value) => value + 1),
  };
}

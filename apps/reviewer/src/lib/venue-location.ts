import { api } from "@code2create/backend/api";
import { ConvexHttpClient } from "convex/browser";
import { ConvexError } from "convex/values";
import { randomUUID } from "expo-crypto";
import * as Location from "expo-location";
import * as SecureStore from "expo-secure-store";
import * as TaskManager from "expo-task-manager";
import { AppState, Platform } from "react-native";
import { z } from "zod";
import { createReviewerAuthClient } from "./auth-client";
import { reviewerConfiguration } from "./config";

export const venueLocationTask = "code2create-reviewer-venue-location";
const storageKey = "code2create.venue-tracking.v1";
const pendingDisableKey = "code2create.venue-tracking.pending-disables";
const issueKey = "code2create.venue-tracking.issue";
const trackingSchema = z.object({
  eventSlug: z.string(),
  installationId: z.string(),
  generation: z.number().int(),
  startedAt: z.number().int(),
  ownerId: z.string(),
  endsAt: z.number(),
  policyVersion: z.number(),
});
const pendingDisableSchema = trackingSchema.pick({
  eventSlug: true,
  installationId: true,
  generation: true,
  ownerId: true,
}).extend({ clientOperationId: z.string() });
const disableErrorSchema = z.object({ code: z.string() });
type PendingDisable = z.infer<typeof pendingDisableSchema>;

const taskDataSchema = z.object({
  locations: z.array(
    z.object({
      timestamp: z.number(),
      mocked: z.boolean().optional(),
      coords: z.object({
        latitude: z.number(),
        longitude: z.number(),
        accuracy: z.number().nullable(),
      }),
    }),
  ),
});
type Tracking = z.infer<typeof trackingSchema>;
type Sample = z.infer<typeof taskDataSchema>["locations"][number];
let trackingChange: Promise<void> = Promise.resolve();

function changeTracking<T>(change: () => Promise<T>): Promise<T> {
  const result = trackingChange.then(change);
  trackingChange = result.then(() => {}).catch(() => {});
  return result;
}

function sameTracking(current: Tracking | null, expected: Tracking) {
  return (
    current?.ownerId === expected.ownerId &&
    current.eventSlug === expected.eventSlug &&
    current.installationId === expected.installationId &&
    current.generation === expected.generation
  );
}

// Defined before React mounts so the native task also works in a headless launch.
TaskManager.defineTask(venueLocationTask, async ({ data, error }) => {
  try {
    if (error)
      throw new Error(
        "Background location is unavailable. Open the app to check permissions.",
      );
    const parsed = taskDataSchema.safeParse(data);
    if (!parsed.success)
      throw new Error("This phone could not read its background location.");
    const latest = parsed.data.locations.reduce<Sample | null>(
      (found, sample) =>
        !found || sample.timestamp > found.timestamp ? sample : found,
      null,
    );
    if (latest) await sendVenueSample(latest);
  } catch {
    await SecureStore.setItemAsync(
      issueKey,
      "Venue checks could not sync. Open the app and refresh your location.",
    );
  }
});

export async function venueHttpClient() {
  if (!reviewerConfiguration)
    throw new Error("The reviewer app is not configured.");
  const auth = createReviewerAuthClient(
    reviewerConfiguration.convexSiteUrl,
    reviewerConfiguration.scheme,
  );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await auth.convex.token({
      fetchOptions: { signal: controller.signal },
    });
    if (!response.data?.token)
      throw new Error("Sign in again to sync venue checks.");
    const client = new ConvexHttpClient(reviewerConfiguration.convexUrl, {
      fetch: async (input, init) => {
        const request = new AbortController();
        const timer = setTimeout(() => request.abort(), 15_000);
        try {
          return await fetch(input, { ...init, signal: request.signal });
        } finally {
          clearTimeout(timer);
        }
      },
    });
    client.setAuth(response.data.token);
    return client;
  } finally {
    clearTimeout(timeout);
  }
}

export async function loadVenueTracking() {
  const value = await SecureStore.getItemAsync(storageKey);
  if (!value) return null;
  const decoded: unknown = JSON.parse(value);
  return trackingSchema.parse(decoded);
}

async function loadPendingDisables(): Promise<PendingDisable[]> {
  const value = await SecureStore.getItemAsync(pendingDisableKey);
  if (!value) return [];
  const decoded: unknown = JSON.parse(value);
  return z.array(pendingDisableSchema).parse(decoded);
}

async function flushPendingDisables(ownerId: string) {
  let pending = await loadPendingDisables();
  for (const request of pending.filter((entry) => entry.ownerId === ownerId)) {
    try {
      const client = await venueHttpClient();
      await client.mutation(api.reviewerVenue.setMonitoring, {
        eventSlug: request.eventSlug,
        installationId: request.installationId,
        enabled: false,
        expectedGeneration: request.generation,
        ownerId: request.ownerId,
        clientOperationId: request.clientOperationId,
      });
    } catch (error) {
      const parsed = disableErrorSchema.safeParse(
        error instanceof ConvexError ? error.data : null,
      );
      if (
        !parsed.success ||
        !["VENUE_DEVICE_CHANGED", "VENUE_TRACKING_CHANGED"].includes(parsed.data.code)
      ) {
        throw error;
      }
      // The requested generation is gone; an old opt-out must not stop its replacement.
    }
    pending = pending.filter((entry) => entry.clientOperationId !== request.clientOperationId);
    if (pending.length) {
      await SecureStore.setItemAsync(pendingDisableKey, JSON.stringify(pending));
    } else {
      await SecureStore.deleteItemAsync(pendingDisableKey);
    }
  }
}

export function retryPendingVenueDisables(ownerId: string) {
  return changeTracking(() => flushPendingDisables(ownerId));
}

export function readVenueTrackingIssue() {
  return SecureStore.getItemAsync(issueKey);
}

async function clearNativeTracking() {
  // Remove the identity first, including when the OS refuses to stop its task.
  await SecureStore.deleteItemAsync(storageKey);
  if (await Location.hasStartedLocationUpdatesAsync(venueLocationTask)) {
    await Location.stopLocationUpdatesAsync(venueLocationTask);
  }
}

export function stopNativeVenueTracking(expected?: Tracking) {
  return changeTracking(async () => {
    if (expected && !sameTracking(await loadVenueTracking(), expected)) return;
    await clearNativeTracking();
  });
}

export async function enableVenueTracking(
  input: Omit<Tracking, "generation" | "startedAt">,
) {
  await changeTracking(async () => {
    await flushPendingDisables(input.ownerId);
    if (Platform.OS !== "ios" && Platform.OS !== "android")
      throw new Error("Venue checks need the installed mobile app.");
    if (!(await Location.hasServicesEnabledAsync()))
      throw new Error("Turn on location services, then try again.");
    const foreground = await Location.requestForegroundPermissionsAsync();
    if (!foreground.granted)
      throw new Error(
        "Location is not allowed. You can still inform the desk when leaving.",
      );
    const client = await venueHttpClient();
    const { generation, startedAt } = await client.mutation(
      api.reviewerVenue.setMonitoring,
      {
        eventSlug: input.eventSlug,
        installationId: input.installationId,
        enabled: true,
        ownerId: input.ownerId,
        clientOperationId: randomUUID(),
      },
    );
    await SecureStore.setItemAsync(
      storageKey,
      JSON.stringify({ ...input, generation, startedAt }),
    );
  });
  await refreshVenueLocation();
}

export function enableBackgroundVenueTracking() {
  return changeTracking(async () => {
    // The UI explains the separate "Allow all the time" permission before calling this.
    const permission = await Location.requestBackgroundPermissionsAsync();
    if (!permission.granted)
      throw new Error(
        "Allow location all the time in Settings to check the venue with the app closed.",
      );
    if (!(await loadVenueTracking()))
      throw new Error("Enable venue checks first.");
    await Location.startLocationUpdatesAsync(venueLocationTask, {
      accuracy: Location.Accuracy.High,
      timeInterval: 60_000,
      distanceInterval: 0,
      deferredUpdatesInterval: 60_000,
      pausesUpdatesAutomatically: false,
      showsBackgroundLocationIndicator: true,
      foregroundService: {
        notificationTitle: "Code2Create venue checks",
        notificationBody:
          "Checking reviewer presence during the event. Manage this in the app.",
        killServiceOnDestroy: true,
      },
    });
  });
}

export function disableVenueTracking() {
  return changeTracking(async () => {
    const tracking = await loadVenueTracking();
    try {
      if (tracking) {
        const pending = await loadPendingDisables();
        pending.push({
          eventSlug: tracking.eventSlug,
          installationId: tracking.installationId,
          generation: tracking.generation,
          ownerId: tracking.ownerId,
          clientOperationId: randomUUID(),
        });
        await SecureStore.setItemAsync(pendingDisableKey, JSON.stringify(pending));
      }
    } finally {
      await clearNativeTracking();
    }
    if (tracking) await flushPendingDisables(tracking.ownerId);
  });
}

export async function refreshVenueLocation() {
  const tracking = await loadVenueTracking();
  if (!tracking) throw new Error("Enable venue checks on this phone first.");
  const sample = await new Promise<Location.LocationObject>(
    (resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              "A precise location could not be found. Try again near a window or outdoors.",
            ),
          ),
        20_000,
      );
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High })
        .then((value) => {
          clearTimeout(timer);
          resolve(value);
        })
        .catch((error: unknown) => {
          clearTimeout(timer);
          reject(
            error instanceof Error
              ? error
              : new Error("This phone could not read its location."),
          );
        });
    },
  );
  await sendVenueSample(sample, tracking);
}

async function sendVenueSample(sample: Sample, expected?: Tracking) {
  const tracking = await loadVenueTracking();
  if (!tracking || (expected && !sameTracking(tracking, expected))) return;
  if (Date.now() >= tracking.endsAt) {
    await stopNativeVenueTracking(tracking);
    return;
  }
  // Upload only the newest fix. Do not retain or replay a travel history while offline.
  if (
    sample.timestamp < tracking.startedAt ||
    Date.now() - sample.timestamp > 120_000
  )
    return;
  const client = await venueHttpClient();
  if (!sameTracking(await loadVenueTracking(), tracking)) return;
  const result = await client.mutation(api.reviewerVenue.reportLocation, {
    eventSlug: tracking.eventSlug,
    installationId: tracking.installationId,
    generation: tracking.generation,
    latitude: sample.coords.latitude,
    longitude: sample.coords.longitude,
    accuracy: sample.coords.accuracy ?? 100_000,
    sampledAt: Math.round(sample.timestamp),
    ...(sample.mocked !== undefined ? { mocked: sample.mocked } : {}),
  });
  if (!result.active) {
    await stopNativeVenueTracking(tracking);
    throw new Error(
      "Venue checks changed. Open the app to reconnect this phone.",
    );
  }
  await SecureStore.deleteItemAsync(issueKey);
}

export function subscribeToForegroundVenueChecks(
  ownerId: string,
  onIssue: (message: string | null) => void,
) {
  let stopped = false;
  let sending = false;
  const check = async () => {
    if (sending || stopped || AppState.currentState !== "active") return;
    sending = true;
    try {
      await retryPendingVenueDisables(ownerId);
      if (await loadVenueTracking()) await refreshVenueLocation();
      if (!stopped) onIssue(null);
    } catch {
      if (!stopped)
        onIssue(
          "Location checks could not sync. Check permissions and refresh your location.",
        );
    } finally {
      sending = false;
    }
  };
  const timer = setInterval(() => void check(), 60_000);
  const subscription = AppState.addEventListener("change", (state) => {
    if (state === "active") void check();
  });
  void check();
  return () => {
    stopped = true;
    clearInterval(timer);
    subscription.remove();
  };
}

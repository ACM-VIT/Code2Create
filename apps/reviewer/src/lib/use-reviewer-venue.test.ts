import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useReviewerVenue } from "./use-reviewer-venue";

const native = vi.hoisted(() => ({
  foreground: false,
  background: false,
  started: false,
  requested: false,
  services: true,
  savedIssue: null as string | null,
  listener: null as ((state: string) => void) | null,
}));
vi.mock("@code2create/backend/api", () => ({
  api: { reviewerVenue: { mine: "mine" } },
}));
vi.mock("convex/react", () => ({
  useQuery: () => ({
    policy: { version: 1 },
    presence: { trackingGeneration: 1, monitoringEnabled: true },
    trackingOnThisDevice: true,
  }),
}));
vi.mock("expo-location", () => ({
  getForegroundPermissionsAsync: async () => ({ granted: native.foreground }),
  getBackgroundPermissionsAsync: async () => ({ granted: native.background }),
  hasStartedLocationUpdatesAsync: async () => native.started,
  hasServicesEnabledAsync: async () => native.services,
}));
vi.mock("react-native", () => ({
  AppState: {
    currentState: "active",
    addEventListener: (_: string, callback: (state: string) => void) => {
      native.listener = callback;
      return {
        remove: () => {
          native.listener = null;
        },
      };
    },
  },
}));
vi.mock("./venue-location", () => ({
  loadVenueTracking: async () => ({
    ownerId: "owner",
    installationId: "phone",
    eventSlug: "event",
    generation: 1,
    policyVersion: 1,
    endsAt: Date.now() + 60_000,
  }),
  readVenueTrackingIssue: async () => native.savedIssue,
  resumeBackgroundVenueTracking: async () => {
    if (native.requested && native.foreground && native.background)
      native.started = true;
    return native.started;
  },
  stopNativeVenueTracking: vi.fn(),
  subscribeToForegroundVenueChecks: () => () => {},
  venueLocationTask: "venue-task",
}));
let renderer: ReturnType<typeof create>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  native.foreground = false;
  native.background = false;
  native.started = false;
  native.requested = false;
  native.services = true;
  native.savedIssue = null;
});

test("returning to the app restores requested background checks and clears a resolved issue", async () => {
  let venue!: ReturnType<typeof useReviewerVenue>;
  function Screen() {
    venue = useReviewerVenue("event", true, "phone", "owner");
    return null;
  }
  native.foreground = true;
  native.background = true;
  native.requested = true;
  native.savedIssue = "Previous sync failed";
  await act(async () => {
    renderer = create(createElement(Screen));
  });
  expect(venue.backgroundEnabled).toBe(true);
  expect(venue.issue).toBe("Previous sync failed");
  native.started = false;
  native.savedIssue = null;
  await act(async () => {
    native.listener?.("active");
  });
  expect(venue.backgroundEnabled).toBe(true);
  expect(venue.issue).toBeNull();
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
});

test("recognizes Settings grants without claiming background tracking has already started", async () => {
  let venue!: ReturnType<typeof useReviewerVenue>;
  function Screen() {
    venue = useReviewerVenue("event", true, "phone", "owner");
    return null;
  }
  await act(async () => {
    renderer = create(createElement(Screen));
  });
  expect(venue.foregroundGranted).toBe(false);
  expect(venue.localEnabled).toBe(false);
  native.foreground = true;
  native.background = true;
  await act(async () => {
    native.listener?.("active");
  });
  expect(venue.foregroundGranted).toBe(true);
  expect(venue.backgroundGranted).toBe(true);
  expect(venue.localEnabled).toBe(true);
  expect(venue.backgroundEnabled).toBe(false);
  native.started = true;
  await act(async () => {
    native.listener?.("active");
  });
  expect(venue.backgroundEnabled).toBe(true);
  native.foreground = false;
  native.background = false;
  await act(async () => {
    native.listener?.("active");
  });
  expect(venue.localEnabled).toBe(false);
  expect(venue.backgroundEnabled).toBe(false);
  expect(venue.localConfigured).toBe(true);
});

test("disabled phone location services do not appear enabled, while stopping remains available", async () => {
  let venue!: ReturnType<typeof useReviewerVenue>;
  function Screen() {
    venue = useReviewerVenue("event", true, "phone", "owner");
    return null;
  }
  native.foreground = true;
  native.background = true;
  native.started = true;
  native.services = false;
  await act(async () => {
    renderer = create(createElement(Screen));
  });
  expect(venue.localEnabled).toBe(false);
  expect(venue.backgroundEnabled).toBe(false);
  expect(venue.localConfigured).toBe(true);
});

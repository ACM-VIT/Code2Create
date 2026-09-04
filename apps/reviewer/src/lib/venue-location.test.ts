import { beforeEach, afterEach, describe, expect, test, vi } from "vitest";

const native = vi.hoisted(() => {
  const storage = new Map<string, string>();
  return {
    storage,
    handler: null as
      | ((payload: {
          data: unknown;
          error: null | { message: string };
        }) => Promise<void>)
      | null,
    mutation: vi.fn(),
    token: vi.fn(),
    position: vi.fn(),
    foreground: vi.fn(),
    background: vi.fn(),
    hasStarted: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    services: vi.fn(),
  };
});
vi.mock("expo-secure-store", () => ({
  getItemAsync: async (key: string) => native.storage.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => {
    native.storage.set(key, value);
  },
  deleteItemAsync: async (key: string) => {
    native.storage.delete(key);
  },
}));
vi.mock("expo-task-manager", () => ({
  defineTask: (_name: string, handler: NonNullable<typeof native.handler>) => {
    native.handler = handler;
  },
}));
vi.mock("expo-location", () => ({
  Accuracy: { High: 4 },
  requestForegroundPermissionsAsync: native.foreground,
  requestBackgroundPermissionsAsync: native.background,
  getCurrentPositionAsync: native.position,
  hasStartedLocationUpdatesAsync: native.hasStarted,
  startLocationUpdatesAsync: native.start,
  stopLocationUpdatesAsync: native.stop,
  hasServicesEnabledAsync: native.services,
}));
vi.mock("expo-crypto", () => ({ randomUUID: () => "fixture-operation" }));
vi.mock("react-native", () => ({
  Platform: { OS: "android" },
  AppState: {
    currentState: "active",
    addEventListener: () => ({ remove: vi.fn() }),
  },
}));
vi.mock("./config", () => ({
  reviewerConfiguration: {
    convexUrl: "https://example.convex.cloud",
    convexSiteUrl: "https://example.convex.site",
    scheme: "code2create-ops",
  },
}));
vi.mock("./auth-client", () => ({
  createReviewerAuthClient: () => ({ convex: { token: native.token } }),
}));
vi.mock("convex/browser", () => ({
  ConvexHttpClient: class {
    mutation = native.mutation;
    setAuth() {}
  },
}));

import {
  disableVenueTracking,
  enableBackgroundVenueTracking,
  enableVenueTracking,
  loadVenueTracking,
  readVenueTrackingIssue,
  refreshVenueLocation,
  venueLocationTask,
} from "./venue-location";
import { visibleVenueStatus } from "./venue-status";

const sample = (timestamp: number, latitude = 12.97) => ({
  timestamp,
  coords: {
    latitude,
    longitude: 79.15,
    accuracy: 10,
    altitude: null,
    altitudeAccuracy: null,
    heading: null,
    speed: null,
  },
});
const setup = {
  eventSlug: "event",
  installationId: "phone",
  ownerId: "reviewer",
  policyVersion: 1,
  endsAt: 1_800_001_000_000,
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_800_000_000_000);
  native.storage.clear();
  vi.clearAllMocks();
  native.services.mockResolvedValue(true);
  native.foreground.mockResolvedValue({ granted: true });
  native.background.mockResolvedValue({ granted: true });
  native.token.mockResolvedValue({ data: { token: "fixture-auth-token" } });
  native.mutation
    .mockReset()
    .mockResolvedValueOnce({ generation: 1 })
    .mockResolvedValue({ accepted: true, active: true });
  native.position.mockResolvedValue(sample(Date.now()));
  native.hasStarted.mockResolvedValue(false);
  native.start.mockResolvedValue(undefined);
  native.stop.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("native venue tracking", () => {
  test("requests permission before enabling and uploads the first fix without persisting coordinates", async () => {
    await enableVenueTracking(setup);
    expect(native.foreground).toHaveBeenCalledOnce();
    expect(native.mutation).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ generation: 1, latitude: 12.97, accuracy: 10 }),
    );
    expect(await loadVenueTracking()).toEqual({ ...setup, generation: 1 });
    for (const value of native.storage.values())
      expect(value).not.toContain("latitude");
    expect(native.start).not.toHaveBeenCalled();
  });

  test("permission denial does not enable or store tracking", async () => {
    native.foreground.mockResolvedValue({ granted: false });
    await expect(enableVenueTracking(setup)).rejects.toThrow(
      "Location is not allowed",
    );
    expect(native.mutation).not.toHaveBeenCalled();
    expect(await loadVenueTracking()).toBeNull();
  });

  test("asks separately for background permission and configures native background updates", async () => {
    await enableVenueTracking(setup);
    await enableBackgroundVenueTracking();
    expect(native.background).toHaveBeenCalledOnce();
    expect(native.start).toHaveBeenCalledWith(
      venueLocationTask,
      expect.objectContaining({
        timeInterval: 60_000,
        distanceInterval: 0,
        pausesUpdatesAutomatically: false,
        showsBackgroundLocationIndicator: true,
      }),
    );
    native.background.mockResolvedValue({ granted: false });
    await expect(enableBackgroundVenueTracking()).rejects.toThrow(
      "Allow location all the time",
    );
    expect(native.start).toHaveBeenCalledOnce();
  });

  test("a headless callback uploads only the newest fix using the stored event and generation", async () => {
    await enableVenueTracking(setup);
    native.mutation.mockClear();
    vi.setSystemTime(Date.now() + 60_000);
    await native.handler?.({
      data: {
        locations: [sample(Date.now(), 13), sample(Date.now() - 1000, 11)],
      },
      error: null,
    });
    expect(native.mutation).toHaveBeenCalledOnce();
    expect(native.mutation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventSlug: "event",
        installationId: "phone",
        generation: 1,
        latitude: 13,
      }),
    );
  });

  test("stops sending at the event end and after local tracking is stopped", async () => {
    await enableVenueTracking(setup);
    native.mutation.mockClear();
    native.hasStarted.mockResolvedValue(true);
    vi.setSystemTime(setup.endsAt);
    await native.handler?.({
      data: { locations: [sample(Date.now())] },
      error: null,
    });
    expect(native.mutation).not.toHaveBeenCalled();
    expect(native.stop).toHaveBeenCalledOnce();
    expect(await loadVenueTracking()).toBeNull();
  });

  test("stopping tracking clears local identity even if the server is unreachable", async () => {
    await enableVenueTracking(setup);
    native.mutation.mockRejectedValue(new Error("Offline"));
    await expect(disableVenueTracking()).rejects.toThrow("Offline");
    expect(await loadVenueTracking()).toBeNull();
    native.mutation.mockClear();
    await native.handler?.({
      data: { locations: [sample(Date.now())] },
      error: null,
    });
    expect(native.mutation).not.toHaveBeenCalled();
  });

  test("expired or replaced tracking stops the native task, while a duplicate fix is harmless", async () => {
    await enableVenueTracking(setup);
    native.mutation.mockResolvedValueOnce({ accepted: false, active: true });
    await refreshVenueLocation();
    expect(await loadVenueTracking()).not.toBeNull();
    native.mutation.mockResolvedValueOnce({ accepted: false, active: false });
    await expect(refreshVenueLocation()).rejects.toThrow(
      "Venue checks changed",
    );
    expect(await loadVenueTracking()).toBeNull();
  });

  test("malformed background data records a readable issue and never posts a location", async () => {
    await native.handler?.({
      data: { locations: [{ unexpected: true }] },
      error: null,
    });
    expect(native.mutation).not.toHaveBeenCalled();
    expect(await readVenueTrackingIssue()).toContain("could not sync");
  });

  test("a delayed rejection for an old generation cannot stop a newly enabled session", async () => {
    await enableVenueTracking(setup);
    let finish = (_result: { accepted: boolean; active: boolean }) => {};
    native.mutation.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const oldRequest = native.handler?.({
      data: { locations: [sample(Date.now())] },
      error: null,
    });
    await vi.waitFor(() => expect(native.mutation).toHaveBeenCalledTimes(3));
    native.mutation.mockResolvedValueOnce({ generation: 2 });
    await enableVenueTracking(setup);
    finish({ accepted: false, active: false });
    await oldRequest;
    expect((await loadVenueTracking())?.generation).toBe(2);
    expect(native.stop).not.toHaveBeenCalled();
  });

  test("a GPS fix requested before stopping cannot be sent under a replacement session", async () => {
    await enableVenueTracking(setup);
    let finish = (_result: ReturnType<typeof sample>) => {};
    native.position.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const oldRequest = refreshVenueLocation();
    await vi.waitFor(() => expect(native.position).toHaveBeenCalledTimes(2));
    await disableVenueTracking();
    native.mutation.mockResolvedValueOnce({ generation: 2 });
    await enableVenueTracking(setup);
    const callsBeforeOldFix = native.mutation.mock.calls.length;
    finish(sample(Date.now()));
    await oldRequest;
    expect(native.mutation).toHaveBeenCalledTimes(callsBeforeOldFix);
    expect((await loadVenueTracking())?.generation).toBe(2);
  });

  test("stale coordinates do not upload and a location timeout becomes a recoverable error", async () => {
    await enableVenueTracking(setup);
    native.mutation.mockClear();
    await native.handler?.({
      data: { locations: [sample(Date.now() - 180_000)] },
      error: null,
    });
    expect(native.mutation).not.toHaveBeenCalled();
    native.position.mockReturnValue(new Promise(() => {}));
    const request = refreshVenueLocation();
    const assertion = expect(request).rejects.toThrow(
      "precise location could not be found",
    );
    await vi.advanceTimersByTimeAsync(20_001);
    await assertion;
  });
});

test("stale location is shown as unavailable while a reported departure remains visible", () => {
  expect(visibleVenueStatus("inside", Date.now() - 180_001, Date.now())).toBe(
    "unknown",
  );
  expect(visibleVenueStatus("left", Date.now(), Date.now())).toBe("left");
  expect(visibleVenueStatus("reported_left", undefined, Date.now())).toBe(
    "reported_left",
  );
});

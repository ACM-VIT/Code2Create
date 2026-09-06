import { beforeEach, afterEach, describe, expect, test, vi } from "vitest";
import { ConvexError } from "convex/values";
import * as SecureStore from "expo-secure-store";
import {
  disableVenueTracking,
  enableBackgroundVenueTracking,
  enableVenueTracking,
  loadVenueTracking,
  readVenueTrackingIssue,
  refreshVenueLocation,
  retryPendingVenueDisables,
  resumeBackgroundVenueTracking,
  subscribeToForegroundVenueChecks,
  venueLocationTask,
} from "./venue-location";
import { visibleVenueStatus } from "./venue-status";
import { describeError } from "./errors";

const native = vi.hoisted(() => {
  const storage = new Map<string, string>();
  return {
    storage,
    accessible: new Map<string, number | undefined>(),
    locked: false,
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
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 2,
  getItemAsync: async (key: string) => {
    if (
      native.locked &&
      native.storage.has(key) &&
      native.accessible.get(key) !== 2
    )
      throw new Error("Keychain is locked");
    return native.storage.get(key) ?? null;
  },
  setItemAsync: async (
    key: string,
    value: string,
    options?: { keychainAccessible: number },
  ) => {
    if (native.locked && options?.keychainAccessible !== 2)
      throw new Error("Keychain is locked");
    native.storage.set(key, value);
    native.accessible.set(key, options?.keychainAccessible);
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
  getForegroundPermissionsAsync: native.foreground,
  getBackgroundPermissionsAsync: native.background,
  getCurrentPositionAsync: native.position,
  hasStartedLocationUpdatesAsync: native.hasStarted,
  startLocationUpdatesAsync: native.start,
  stopLocationUpdatesAsync: native.stop,
  hasServicesEnabledAsync: native.services,
}));
vi.mock("expo-crypto", () => ({ randomUUID: () => crypto.randomUUID() }));
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
  native.accessible.clear();
  native.locked = false;
  vi.clearAllMocks();
  native.services.mockResolvedValue(true);
  native.foreground.mockResolvedValue({ granted: true });
  native.background.mockResolvedValue({ granted: true });
  native.token.mockResolvedValue({ data: { token: "fixture-auth-token" } });
  native.mutation
    .mockReset()
    .mockResolvedValueOnce({ generation: 1, startedAt: Date.now() })
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
    expect(await loadVenueTracking()).toEqual({
      ...setup,
      generation: 1,
      startedAt: Date.now(),
    });
    for (const value of native.storage.values())
      expect(value).not.toContain("latitude");
    expect(native.start).not.toHaveBeenCalled();
  });

  test("a delayed callback from the previous account cannot upload into the new tracking session", async () => {
    await enableVenueTracking(setup);
    const delayed = sample(Date.now());
    vi.setSystemTime(Date.now() + 60000);
    native.mutation.mockResolvedValueOnce({
      generation: 2,
      startedAt: Date.now(),
    });
    native.position.mockResolvedValue(sample(Date.now()));
    await enableVenueTracking({ ...setup, ownerId: "second-reviewer" });
    native.mutation.mockClear();
    await native.handler?.({ data: { locations: [delayed] }, error: null });
    expect(native.mutation).not.toHaveBeenCalled();
    expect(await loadVenueTracking()).toMatchObject({
      ownerId: "second-reviewer",
      generation: 2,
    });
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

  test("shows the Settings recovery instruction when background permission is denied", async () => {
    await enableVenueTracking(setup);
    native.background.mockResolvedValue({ granted: false });
    const error = await enableBackgroundVenueTracking().catch(
      (caught: unknown) => caught,
    );
    expect(describeError(error, "Could not save")).toBe(
      "Allow location all the time in Settings to check the venue while the screen is locked.",
    );
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

  test("a locked-screen task can read its session, upload a fix, and save a sync failure", async () => {
    await enableVenueTracking(setup);
    native.locked = true;
    native.mutation.mockClear();
    await native.handler?.({
      data: { locations: [sample(Date.now())] },
      error: null,
    });
    expect(native.mutation).toHaveBeenCalledOnce();
    expect(await readVenueTrackingIssue()).toBeNull();
    native.mutation.mockRejectedValueOnce(new Error("Offline"));
    await native.handler?.({
      data: { locations: [sample(Date.now())] },
      error: null,
    });
    expect(await readVenueTrackingIssue()).toContain("could not sync");
  });

  test("reopening restores an explicitly enabled background task without prompting again", async () => {
    await enableVenueTracking(setup);
    await enableBackgroundVenueTracking();
    const tracking = await loadVenueTracking();
    if (!tracking) throw new Error("Missing tracking fixture");
    native.start.mockClear();
    // The OS has stopped the task; the saved choice survives the process restart.
    expect(await resumeBackgroundVenueTracking(tracking)).toBe(true);
    expect(native.start).toHaveBeenCalledOnce();
    native.hasStarted.mockResolvedValue(true);
    expect(await resumeBackgroundVenueTracking(tracking)).toBe(true);
    expect(native.start).toHaveBeenCalledOnce();
  });

  test("foreground-only sessions do not acquire background tracking from an earlier permission grant", async () => {
    await enableVenueTracking(setup);
    const tracking = await loadVenueTracking();
    if (!tracking) throw new Error("Missing tracking fixture");
    expect(await resumeBackgroundVenueTracking(tracking)).toBe(false);
    expect(native.start).not.toHaveBeenCalled();
  });

  test.each([
    "foreground",
    "background",
    "services",
    "expired",
    "stopped",
  ] as const)(
    "does not resume background checks when %s is unavailable",
    async (unavailable) => {
      await enableVenueTracking(setup);
      await enableBackgroundVenueTracking();
      const tracking = await loadVenueTracking();
      if (!tracking) throw new Error("Missing tracking fixture");
      native.start.mockClear();
      if (unavailable === "foreground")
        native.foreground.mockResolvedValue({ granted: false });
      if (unavailable === "background")
        native.background.mockResolvedValue({ granted: false });
      if (unavailable === "services") native.services.mockResolvedValue(false);
      if (unavailable === "expired") vi.setSystemTime(setup.endsAt);
      if (unavailable === "stopped") await disableVenueTracking();
      expect(await resumeBackgroundVenueTracking(tracking)).toBe(false);
      expect(native.start).not.toHaveBeenCalled();
    },
  );

  test("a new account or generation cannot inherit the previous session's background choice", async () => {
    await enableVenueTracking(setup);
    await enableBackgroundVenueTracking();
    const previous = await loadVenueTracking();
    if (!previous) throw new Error("Missing tracking fixture");
    native.hasStarted.mockResolvedValue(true);
    native.mutation.mockResolvedValueOnce({
      generation: 2,
      startedAt: Date.now(),
    });
    await enableVenueTracking({ ...setup, ownerId: "second-reviewer" });
    expect(native.stop).toHaveBeenCalledOnce();
    native.start.mockClear();
    expect(await resumeBackgroundVenueTracking(previous)).toBe(false);
    const current = await loadVenueTracking();
    if (!current) throw new Error("Missing tracking fixture");
    expect(await resumeBackgroundVenueTracking(current)).toBe(false);
    expect(native.start).not.toHaveBeenCalled();
    native.position.mockClear();
    await refreshVenueLocation(previous);
    expect(native.position).not.toHaveBeenCalled();
    native.mutation.mockClear();
    const onIssue = vi.fn();
    const stop = subscribeToForegroundVenueChecks(setup.ownerId, onIssue);
    try {
      await vi.waitFor(() => expect(onIssue).toHaveBeenCalledWith(null));
      expect(native.mutation).not.toHaveBeenCalled();
    } finally {
      stop();
    }
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

  test("stops expired foreground checks without waiting for another GPS fix", async () => {
    await enableVenueTracking(setup);
    native.position.mockClear();
    native.hasStarted.mockResolvedValue(true);
    vi.setSystemTime(setup.endsAt);
    await refreshVenueLocation();
    expect(native.position).not.toHaveBeenCalled();
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

  test("retries a persisted offline opt-out on foreground checks without uploading a location", async () => {
    await enableVenueTracking(setup);
    native.mutation.mockRejectedValueOnce(new Error("Offline"));
    await expect(disableVenueTracking()).rejects.toThrow("Offline");
    const request = native.mutation.mock.calls.at(-1)?.[1];
    expect(request).toMatchObject({ enabled: false, expectedGeneration: 1 });
    native.mutation.mockClear();
    const onIssue = vi.fn();
    const stop = subscribeToForegroundVenueChecks(setup.ownerId, onIssue);
    try {
      await vi.waitFor(() => expect(native.mutation).toHaveBeenCalledOnce());
      expect(native.mutation).toHaveBeenLastCalledWith(
        expect.anything(),
        request,
      );
      await vi.waitFor(() => expect(onIssue).toHaveBeenCalledWith(null));
      expect(await loadVenueTracking()).toBeNull();
      native.mutation.mockClear();
      await retryPendingVenueDisables(setup.ownerId);
      expect(native.mutation).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });

  test("keeps offline opt-outs separate across account changes", async () => {
    await enableVenueTracking(setup);
    native.mutation.mockRejectedValueOnce(new Error("Offline"));
    await expect(disableVenueTracking()).rejects.toThrow("Offline");
    const firstRequest = native.mutation.mock.calls.at(-1)?.[1];
    native.mutation.mockClear();
    await retryPendingVenueDisables("second-reviewer");
    expect(native.mutation).not.toHaveBeenCalled();
    native.mutation.mockResolvedValueOnce({
      generation: 2,
      startedAt: Date.now(),
    });
    await enableVenueTracking({ ...setup, ownerId: "second-reviewer" });
    native.mutation.mockRejectedValueOnce(new Error("Offline again"));
    await expect(disableVenueTracking()).rejects.toThrow("Offline again");
    const secondRequest = native.mutation.mock.calls.at(-1)?.[1];
    native.mutation.mockClear();
    await retryPendingVenueDisables("second-reviewer");
    expect(native.mutation).toHaveBeenCalledOnce();
    expect(native.mutation).toHaveBeenLastCalledWith(
      expect.anything(),
      secondRequest,
    );
    native.mutation.mockClear();
    await retryPendingVenueDisables(setup.ownerId);
    expect(native.mutation).toHaveBeenCalledOnce();
    expect(native.mutation).toHaveBeenLastCalledWith(
      expect.anything(),
      firstRequest,
    );
  });

  test("discards only superseded opt-outs and leaves the newer tracking generation intact", async () => {
    await enableVenueTracking(setup);
    native.mutation.mockRejectedValueOnce(new Error("Offline"));
    await expect(disableVenueTracking()).rejects.toThrow("Offline");
    native.mutation
      .mockRejectedValueOnce(
        new ConvexError({
          code: "VENUE_TRACKING_CHANGED",
          message: "Replaced",
        }),
      )
      .mockResolvedValueOnce({ generation: 3, startedAt: Date.now() });
    await enableVenueTracking(setup);
    expect((await loadVenueTracking())?.generation).toBe(3);
    native.mutation.mockClear();
    await retryPendingVenueDisables(setup.ownerId);
    expect(native.mutation).not.toHaveBeenCalled();
  });

  test("stops local tracking even when the pending opt-out cannot be saved", async () => {
    await enableVenueTracking(setup);
    const write = vi
      .spyOn(SecureStore, "setItemAsync")
      .mockRejectedValueOnce(new Error("Storage unavailable"));
    try {
      await expect(disableVenueTracking()).rejects.toThrow(
        "Storage unavailable",
      );
      expect(await loadVenueTracking()).toBeNull();
      native.mutation.mockClear();
      await native.handler?.({
        data: { locations: [sample(Date.now())] },
        error: null,
      });
      expect(native.mutation).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
    }
  });

  test("persists the opt-out even when stopping the native task fails", async () => {
    await enableVenueTracking(setup);
    native.hasStarted.mockResolvedValue(true);
    native.stop.mockRejectedValueOnce(new Error("Native stop failed"));
    await expect(disableVenueTracking()).rejects.toThrow("Native stop failed");
    expect(await loadVenueTracking()).toBeNull();
    native.mutation.mockClear();
    await retryPendingVenueDisables(setup.ownerId);
    expect(native.mutation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        enabled: false,
        expectedGeneration: 1,
      }),
    );
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
    native.mutation.mockResolvedValueOnce({
      generation: 2,
      startedAt: Date.now(),
    });
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
    native.mutation.mockResolvedValueOnce({
      generation: 2,
      startedAt: Date.now(),
    });
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

import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  currentReviewerPushRegistration,
  pagingReadiness,
  requestReviewerPushRegistration,
} from "./push-notifications";

const native = vi.hoisted(() => ({
  platform: { OS: "android" },
  permission: vi.fn(),
  request: vi.fn(),
  token: vi.fn(),
  channel: vi.fn(),
  readiness: vi.fn(),
  settings: vi.fn(),
}));
vi.mock("react-native", () => ({
  Platform: native.platform,
  Linking: { openSettings: native.settings },
}));
vi.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "sha256" },
  digestStringAsync: async () => "fingerprint",
}));
vi.mock("./pager-alarm", () => ({ androidPagingReadiness: native.readiness }));
vi.mock("expo-notifications", () => ({
  setNotificationHandler: vi.fn(),
  getPermissionsAsync: native.permission,
  requestPermissionsAsync: native.request,
  getDevicePushTokenAsync: native.token,
  setNotificationChannelAsync: native.channel,
  IosAuthorizationStatus: { PROVISIONAL: 3 },
  AndroidImportance: { MAX: 5, HIGH: 4 },
  AndroidNotificationVisibility: { PUBLIC: 1 },
}));

beforeEach(() => {
  vi.clearAllMocks();
  native.platform.OS = "android";
  native.permission.mockResolvedValue({ granted: true, canAskAgain: true });
  native.readiness.mockResolvedValue({
    fullScreenAllowed: true,
    batteryUnrestricted: true,
  });
  native.token.mockResolvedValue({ data: "fcm:valid_test_token_1234567890" });
});

test("Android reports the actual full-screen and battery switches, including later revocation", async () => {
  expect((await pagingReadiness()).map(({ met }) => met)).toEqual([
    true,
    true,
    true,
  ]);
  native.readiness.mockResolvedValue({
    fullScreenAllowed: false,
    batteryUnrestricted: false,
  });
  expect((await pagingReadiness()).map(({ met }) => met)).toEqual([
    true,
    false,
    false,
  ]);
});

test("iPhone recognizes granted critical alerts and omits unsupported critical alerts", async () => {
  native.platform.OS = "ios";
  native.permission.mockResolvedValue({
    granted: true,
    ios: { allowsCriticalAlerts: true },
  });
  expect((await pagingReadiness()).map(({ met }) => met)).toEqual([true, true]);
  native.permission.mockResolvedValue({
    granted: true,
    ios: { allowsCriticalAlerts: null },
  });
  expect(await pagingReadiness()).toHaveLength(1);
  expect(native.readiness).not.toHaveBeenCalled();
});

describe.each(["android", "ios"])("%s push", (platform) => {
  test("registers a permission already granted in Settings without another prompt", async () => {
    native.platform.OS = platform;
    native.token.mockResolvedValue({
      data:
        platform === "ios" ? "a".repeat(64) : "fcm:valid_test_token_1234567890",
    });
    expect(await requestReviewerPushRegistration("production")).toMatchObject({
      status: "ready",
    });
    expect(native.request).not.toHaveBeenCalled();
    native.permission.mockResolvedValue({ granted: false });
    expect(await currentReviewerPushRegistration("production")).toEqual({
      status: "not_granted",
    });
  });
});

test("a granted permission stays checked when token registration is unavailable", async () => {
  native.token.mockRejectedValue(new Error("offline"));
  expect(await currentReviewerPushRegistration("production")).toMatchObject({
    status: "unavailable",
  });
  expect((await pagingReadiness())[0]?.met).toBe(true);
});

test("signals the permission grant before waiting for push registration", async () => {
  const pendingToken = Promise.withResolvers<{ data: string }>();
  native.token.mockReturnValue(pendingToken.promise);
  native.permission.mockResolvedValueOnce({
    granted: false,
    canAskAgain: true,
  });
  native.request.mockResolvedValue({ granted: true });
  const changed = vi.fn();
  const request = requestReviewerPushRegistration("production", changed);
  await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
  pendingToken.resolve({ data: "fcm:valid_test_token_1234567890" });
  expect(await request).toMatchObject({ status: "ready" });
});

test("does not report reachable if permission was revoked while fetching the token", async () => {
  native.permission
    .mockResolvedValueOnce({ granted: true })
    .mockResolvedValue({ granted: false });
  native.token.mockResolvedValue({ data: "fcm:valid_test_token_1234567890" });
  expect(await currentReviewerPushRegistration("production")).toEqual({
    status: "not_granted",
  });
});

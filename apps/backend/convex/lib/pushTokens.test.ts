import assert from "node:assert/strict";
import test from "node:test";

import { normalizeNativePushRegistration, pushTokenFingerprint } from "./pushTokens.ts";

test("normalizes native FCM and APNs registrations without an Expo project", () => {
  const fcmToken = "fcm-token:value_12345678901234567890";
  assert.deepEqual(
    normalizeNativePushRegistration({
      token: fcmToken,
      provider: "fcm",
      environment: "production",
      platform: "android",
    }),
    { token: fcmToken, provider: "fcm", environment: "production" },
  );

  const apnsToken = "ABCDEF0123456789".repeat(4);
  assert.deepEqual(
    normalizeNativePushRegistration({
      token: apnsToken,
      provider: "apns",
      environment: "development",
      platform: "ios",
    }),
    { token: apnsToken.toLowerCase(), provider: "apns", environment: "development" },
  );
  assert.equal(pushTokenFingerprint(fcmToken).length, 64);
});

test("rejects partial and cross-platform native push registrations", () => {
  assert.throws(() =>
    normalizeNativePushRegistration({
      token: "fcm-token:value_12345678901234567890",
      provider: "apns",
      environment: "production",
      platform: "android",
    }),
  );
  assert.throws(() =>
    normalizeNativePushRegistration({
      token: "fcm-token:value_12345678901234567890",
      provider: undefined,
      environment: undefined,
      platform: "android",
    }),
  );
});

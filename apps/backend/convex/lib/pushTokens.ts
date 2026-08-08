import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { ConvexError } from "convex/values";

export type NativePushProvider = "fcm" | "apns";
export type PushEnvironment = "development" | "production";

export function normalizeNativePushRegistration(args: {
  token: string | undefined;
  provider: NativePushProvider | undefined;
  environment: PushEnvironment | undefined;
  platform: "android" | "ios";
}) {
  const supplied = [args.token, args.provider, args.environment].filter(
    (value) => value !== undefined,
  ).length;
  if (supplied === 0) return undefined;
  if (supplied !== 3 || !args.token || !args.provider || !args.environment) {
    throw invalidPushToken("The native notification registration is incomplete.");
  }
  if (
    (args.platform === "android" && args.provider !== "fcm") ||
    (args.platform === "ios" && args.provider !== "apns")
  ) {
    throw invalidPushToken("The notification provider does not match this phone.");
  }

  const token = args.token.trim();
  if (args.provider === "apns") {
    if (!/^[A-Fa-f0-9]{32,512}$/.test(token)) {
      throw invalidPushToken("The APNs token returned for this phone is invalid.");
    }
    return { token: token.toLowerCase(), provider: args.provider, environment: args.environment };
  }
  if (
    args.environment !== "production" ||
    token.length < 20 ||
    token.length > 4_096 ||
    !/^[A-Za-z0-9:_-]+$/.test(token)
  ) {
    throw invalidPushToken("The FCM token returned for this phone is invalid.");
  }
  return { token, provider: args.provider, environment: args.environment };
}

export function pushTokenFingerprint(value: string) {
  return bytesToHex(sha256(utf8ToBytes(value)));
}

function invalidPushToken(message: string) {
  return new ConvexError({ code: "INVALID_NATIVE_PUSH_TOKEN", message });
}

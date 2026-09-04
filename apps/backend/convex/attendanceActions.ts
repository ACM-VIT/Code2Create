import { attendanceBadgeReference, attendanceQrPayload } from "@code2create/domain";
import { ConvexError, v, type Infer } from "convex/values";

import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { ActionCtx } from "./_generated/server";
import { action, internalAction } from "./_generated/server";
import { attendanceScanTransition, barcodeSymbology } from "./values";

type BarcodeSymbology = Infer<typeof barcodeSymbology>;
type KeySetResult = {
  keySetId: Id<"attendanceBarcodeKeySets">;
  eventId: Id<"events">;
  eventSlug: string;
  encryptedKey: string;
  iv: string;
  authTag: string;
  wrappingKeyVersion: string;
  barcodeSymbologies: BarcodeSymbology[];
  barcodeNormalizationVersion: string;
};
type CredentialKeyResult = {
  key: Uint8Array<ArrayBuffer>;
  barcodeSymbologies: BarcodeSymbology[];
  barcodeNormalizationVersion: string;
};
type AttendanceKeySetResult = {
  keySetId: Id<"attendanceBarcodeKeySets">;
  eventId: Id<"events">;
  eventSlug: string;
  encryptedKey: string;
  iv: string;
  authTag: string;
  wrappingKeyVersion: string;
};
type WrappedEventKey = Pick<
  AttendanceKeySetResult,
  "encryptedKey" | "iv" | "authTag" | "wrappingKeyVersion"
>;
type RegisterDeviceResult = {
  deviceInstallationId: Id<"attendanceDeviceInstallations">;
  stationId: Id<"attendanceStations">;
};
type ScannerHeartbeatResult = { serverNow: number };
type BeginEnrollmentResult = {
  credentialId: Id<"attendanceCredentials">;
  verificationRequired: true;
};
type VerifyEnrollmentResult = {
  credentialId: Id<"attendanceCredentials">;
  verified: true;
};
type VerifyReplacementResult = VerifyEnrollmentResult & {
  replacedCredentialId: Id<"attendanceCredentials">;
};
type BeginBadgeResult = BeginEnrollmentResult & { badgeReference: string };
type VerifyBadgeResult = VerifyEnrollmentResult & { badgeReference: string };
type VerifyBadgeReplacementResult = VerifyReplacementResult & { badgeReference: string };
type RevokeBadgeResult = { credentialId: Id<"attendanceCredentials">; revoked: true };
type SuspendVitResult = { credentialId: Id<"attendanceCredentials">; suspended: true };
type ExternalIdentityLinkResult = {
  bindingId: Id<"attendanceExternalIdentityBindings">;
  verified: true;
};
type StaffedParticipantResult = {
  resolutionId: Id<"staffedParticipantResolutions">;
  membershipId: Id<"eventMemberships">;
  participantClass: "vit_student" | "external_participant";
  displayName: string;
  institution: string;
  teamName: string;
  vitRegistrationNumber?: string;
  vitScanRelationship?: "unbound" | "current_active" | "current_suspended" | "replacement";
  credential:
    | {
        kind: "vit_id_barcode";
        state: "not_enrolled";
        canEnrol: boolean;
      }
    | {
        kind: "vit_id_barcode";
        state: "active" | "suspended";
        credentialId: Id<"attendanceCredentials">;
        expectedCredentialVersion: number;
        canRebind: boolean;
        canSuspend: boolean;
      }
    | {
        kind: "external_pass";
        state: "active";
      }
    | {
        kind: "badge_qr";
        state: "not_issued";
        canIssue: boolean;
      }
    | {
        kind: "badge_qr";
        state: "active";
        credentialId: Id<"attendanceCredentials">;
        expectedCredentialVersion: number;
        badgeReference: string;
        canReplace: boolean;
        canRevoke: boolean;
      };
  venueCheckIn: null | {
    id: Id<"venueCheckIns">;
    status: "checked_in" | "reversed";
    version: number;
    checkedInAt: number;
    stationName: string;
    reversedAt?: number;
  };
  canRecordVenueCheckIn: boolean;
  canOverrideVenueIdentity: boolean;
  canReverseVenueCheckIn: boolean;
};
type VenueCheckInResult = {
  checkInId: Id<"venueCheckIns">;
  status: "checked_in";
  checkedInAt: number;
  version: number;
  identityCheckMethod: "vit_id" | "external_photo_id" | "approved_exception";
  teamStatusChanged: boolean;
};
type VenueCheckInReversalResult = {
  checkInId: Id<"venueCheckIns">;
  status: "reversed";
  reversedAt: number;
  version: number;
  teamStatusChanged: boolean;
};
type ScanTransition = "venue_entry" | "venue_exit" | "session_confirm" | "zone_entry" | "zone_exit";
type ScanReceipt = {
  presenceEventId: Id<"attendancePresenceEvents">;
  outcome: "accepted" | "duplicate" | "rejected" | "needs_review";
  reasonCode: string;
  serverTime: number;
  transition: ScanTransition;
  previousState?: string;
  nextState?: string;
  participant: null | {
    membershipId: Id<"eventMemberships">;
    displayName: string;
    teamName?: string;
    vitRegistrationNumber?: string;
  };
};
type ExternalPassResult = {
  passId: Id<"attendanceExternalPasses">;
  payload: string;
};
type EncryptedExternalPassBearer = {
  encryptedBearer: string;
  bearerIv: string;
  bearerAuthTag: string;
};
type ExternalPassWalletDetails = EncryptedExternalPassBearer & {
  passId: Id<"attendanceExternalPasses">;
  eventSlug: string;
  eventName: string;
  eventStartsAt: number;
  eventEndsAt: number;
  eventTimezone: string;
  venueName: string;
  participantName: string;
  teamName: string;
};
type ExternalPassWalletResult = {
  passId: Id<"attendanceExternalPasses">;
  payload: string;
  eventName: string;
  eventStartsAt: number;
  eventEndsAt: number;
  eventTimezone: string;
  venueName: string;
  participantName: string;
  teamName: string;
};

const textEncoder = new TextEncoder();
const keyVersionPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const encodedKeyPattern = /^[A-Za-z0-9_-]{43}$/u;

type AttendanceWrappingKey = {
  version: string;
  key: Uint8Array<ArrayBuffer>;
};

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlToBytes(value: string) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/") + padding);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function ownedBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy;
}

async function sha256(value: string) {
  return bytesToHex(
    new Uint8Array(await crypto.subtle.digest("SHA-256", textEncoder.encode(value))),
  );
}

async function deviceSecretHash(secret: string) {
  if (!/^[a-f0-9]{64}$/u.test(secret)) {
    throw new ConvexError({
      code: "INVALID_DEVICE_SECRET",
      message: "The scanner installation secret is invalid.",
    });
  }
  return sha256(secret);
}

function attendanceKeyConfigurationError(): never {
  throw new ConvexError({
    code: "ATTENDANCE_KEYS_INVALID",
    message:
      "The attendance key configuration is invalid. Tell the platform team before scanning continues.",
  });
}

function configuredAttendanceKey(
  version: string | undefined,
  encoded: string | undefined,
): AttendanceWrappingKey {
  if (
    !version ||
    !keyVersionPattern.test(version) ||
    !encoded ||
    !encodedKeyPattern.test(encoded)
  ) {
    return attendanceKeyConfigurationError();
  }
  let key: Uint8Array;
  try {
    key = base64UrlToBytes(encoded);
  } catch {
    return attendanceKeyConfigurationError();
  }
  if (key.length !== 32) return attendanceKeyConfigurationError();
  return { version, key: ownedBytes(key) };
}

function equalKeyMaterial(left: Uint8Array, right: Uint8Array) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

function attendanceKeyConfiguration() {
  const currentVersion = process.env.ATTENDANCE_WRAPPING_KEY_VERSION?.trim();
  const currentEncoded = process.env.ATTENDANCE_WRAPPING_KEY?.trim();
  if (!currentVersion && !currentEncoded) {
    throw new ConvexError({
      code: "ATTENDANCE_KEYS_NOT_CONFIGURED",
      message: "Attendance credential keys are not configured for this environment.",
    });
  }
  const current = configuredAttendanceKey(currentVersion, currentEncoded);
  const previousVersion = process.env.ATTENDANCE_PREVIOUS_WRAPPING_KEY_VERSION?.trim();
  const previousEncoded = process.env.ATTENDANCE_PREVIOUS_WRAPPING_KEY?.trim();
  if (!previousVersion && !previousEncoded) return { current, previous: null };
  const previous = configuredAttendanceKey(previousVersion, previousEncoded);
  if (previous.version === current.version || equalKeyMaterial(previous.key, current.key)) {
    return attendanceKeyConfigurationError();
  }
  return { current, previous };
}

function wrappingKey(version: string) {
  const configuration = attendanceKeyConfiguration();
  if (configuration.current.version === version) return configuration.current.key;
  if (configuration.previous?.version === version) return configuration.previous.key;
  throw new ConvexError({
    code: "ATTENDANCE_KEYS_NOT_CONFIGURED",
    message: "Attendance credential keys are not configured for this environment.",
  });
}

function currentWrappingKey() {
  return attendanceKeyConfiguration().current;
}

function aad(eventSlug: string) {
  return textEncoder.encode(`code2create:attendance:${eventSlug}`);
}

async function encryptedKeyCandidate(eventSlug: string) {
  const eventKey = crypto.getRandomValues(new Uint8Array(32));
  return encryptEventKey(eventSlug, eventKey);
}

function wrappedEventKey(value: WrappedEventKey): WrappedEventKey {
  return {
    encryptedKey: value.encryptedKey,
    iv: value.iv,
    authTag: value.authTag,
    wrappingKeyVersion: value.wrappingKeyVersion,
  };
}

export async function encryptEventKey(eventSlug: string, eventKey: Uint8Array) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const { version, key } = currentWrappingKey();
  const cryptoKey = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt"]);
  const encryptedWithTag = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: aad(eventSlug), tagLength: 128 },
      cryptoKey,
      ownedBytes(eventKey),
    ),
  );
  const tagOffset = encryptedWithTag.length - 16;
  const encryptedKey = encryptedWithTag.slice(0, tagOffset);
  const authTag = encryptedWithTag.slice(tagOffset);
  return {
    encryptedKey: bytesToBase64Url(encryptedKey),
    iv: bytesToBase64Url(iv),
    authTag: bytesToBase64Url(authTag),
    wrappingKeyVersion: version,
  };
}

export async function decryptEventKey(args: {
  eventSlug: string;
  encryptedKey: string;
  iv: string;
  authTag: string;
  wrappingKeyVersion: string;
}) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    wrappingKey(args.wrappingKeyVersion),
    "AES-GCM",
    false,
    ["decrypt"],
  );
  const encryptedKey = base64UrlToBytes(args.encryptedKey);
  const authTag = base64UrlToBytes(args.authTag);
  const encryptedWithTag = new Uint8Array(encryptedKey.length + authTag.length);
  encryptedWithTag.set(encryptedKey);
  encryptedWithTag.set(authTag, encryptedKey.length);
  const key = new Uint8Array(
    await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: base64UrlToBytes(args.iv),
        additionalData: aad(args.eventSlug),
        tagLength: 128,
      },
      cryptoKey,
      encryptedWithTag,
    ),
  );
  if (key.length !== 32) {
    throw new ConvexError({
      code: "ATTENDANCE_KEYS_INVALID",
      message:
        "The event's attendance key cannot be read. Tell the platform team before scanning continues.",
    });
  }
  return key;
}

async function credentialKey(
  ctx: ActionCtx,
  args: {
    eventSlug: string;
    stationId: Id<"attendanceStations">;
    expectedConfigurationVersion: number;
    deviceInstallationId: Id<"attendanceDeviceInstallations">;
    deviceSecretHash: string;
    purpose: "setup" | "scan";
  },
): Promise<CredentialKeyResult> {
  const candidate = await encryptedKeyCandidate(args.eventSlug);
  const keySet: KeySetResult = await ctx.runMutation(
    internal.attendanceSecurity.ensureBarcodeKeySet,
    {
      ...args,
      candidate,
    },
  );
  const key = await decryptEventKey(keySet);
  if (keySet.wrappingKeyVersion !== currentWrappingKey().version) {
    const rewrapped = await encryptEventKey(keySet.eventSlug, key);
    await ctx.runMutation(internal.attendanceSecurity.commitKeySetRewrap, {
      keySetId: keySet.keySetId,
      eventId: keySet.eventId,
      expected: wrappedEventKey(keySet),
      rewrapped,
    });
  }
  return {
    key,
    barcodeSymbologies: keySet.barcodeSymbologies,
    barcodeNormalizationVersion: keySet.barcodeNormalizationVersion,
  };
}

async function externalPassCredentialKey(
  ctx: ActionCtx,
  eventSlug: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const candidate = await encryptedKeyCandidate(eventSlug);
  const keySet: AttendanceKeySetResult = await ctx.runMutation(
    internal.attendanceSecurity.ensureExternalPassKeySet,
    { eventSlug, candidate },
  );
  const key = await decryptEventKey(keySet);
  if (keySet.wrappingKeyVersion !== currentWrappingKey().version) {
    const rewrapped = await encryptEventKey(keySet.eventSlug, key);
    await ctx.runMutation(internal.attendanceSecurity.commitKeySetRewrap, {
      keySetId: keySet.keySetId,
      eventId: keySet.eventId,
      expected: wrappedEventKey(keySet),
      rewrapped,
    });
  }
  return key;
}

async function deliveryCredentialKey(
  ctx: ActionCtx,
  eventSlug: string,
  membershipId: Id<"eventMemberships">,
): Promise<Uint8Array<ArrayBuffer>> {
  const candidate = await encryptedKeyCandidate(eventSlug);
  const keySet: AttendanceKeySetResult = await ctx.runMutation(
    internal.attendanceSecurity.ensureExternalPassDeliveryKeySet,
    { eventSlug, membershipId, candidate },
  );
  return decryptEventKey(keySet);
}

async function existingAttendanceCredentialKey(
  ctx: ActionCtx,
  eventSlug: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const keySet: AttendanceKeySetResult = await ctx.runQuery(
    internal.attendanceSecurity.keySetForRotation,
    { eventSlug },
  );
  return decryptEventKey(keySet);
}

function externalPassAad(eventSlug: string) {
  return textEncoder.encode(`code2create:attendance:${eventSlug}:external-pass:v1`);
}

async function encryptExternalPassBearer(
  eventSlug: string,
  eventKey: Uint8Array,
  bearer: string,
): Promise<EncryptedExternalPassBearer> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey("raw", ownedBytes(eventKey), "AES-GCM", false, [
    "encrypt",
  ]);
  const encryptedWithTag = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: externalPassAad(eventSlug), tagLength: 128 },
      key,
      textEncoder.encode(bearer),
    ),
  );
  const tagOffset = encryptedWithTag.length - 16;
  return {
    encryptedBearer: bytesToBase64Url(encryptedWithTag.slice(0, tagOffset)),
    bearerIv: bytesToBase64Url(iv),
    bearerAuthTag: bytesToBase64Url(encryptedWithTag.slice(tagOffset)),
  };
}

async function decryptExternalPassBearer(
  eventSlug: string,
  eventKey: Uint8Array,
  encrypted: EncryptedExternalPassBearer,
) {
  const key = await crypto.subtle.importKey("raw", ownedBytes(eventKey), "AES-GCM", false, [
    "decrypt",
  ]);
  const ciphertext = base64UrlToBytes(encrypted.encryptedBearer);
  const authTag = base64UrlToBytes(encrypted.bearerAuthTag);
  const encryptedWithTag = new Uint8Array(ciphertext.length + authTag.length);
  encryptedWithTag.set(ciphertext);
  encryptedWithTag.set(authTag, ciphertext.length);
  const decrypted = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: base64UrlToBytes(encrypted.bearerIv),
      additionalData: externalPassAad(eventSlug),
      tagLength: 128,
    },
    key,
    encryptedWithTag,
  );
  const bearer = new TextDecoder().decode(decrypted);
  if (!encodedKeyPattern.test(bearer)) throw new Error("The external event pass is corrupted.");
  return bearer;
}

export const rewrapEventKey = internalAction({
  args: { eventSlug: v.string(), dryRun: v.boolean() },
  returns: v.object({
    eventSlug: v.string(),
    fromVersion: v.string(),
    toVersion: v.string(),
    rewrapped: v.boolean(),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{
    eventSlug: string;
    fromVersion: string;
    toVersion: string;
    rewrapped: boolean;
  }> => {
    const keySet: AttendanceKeySetResult = await ctx.runQuery(
      internal.attendanceSecurity.keySetForRotation,
      { eventSlug: args.eventSlug },
    );
    const key = await decryptEventKey(keySet);
    const toVersion = currentWrappingKey().version;
    if (args.dryRun || keySet.wrappingKeyVersion === toVersion) {
      return {
        eventSlug: keySet.eventSlug,
        fromVersion: keySet.wrappingKeyVersion,
        toVersion,
        rewrapped: false,
      };
    }
    const rewrapped = await encryptEventKey(keySet.eventSlug, key);
    const committed: boolean = await ctx.runMutation(
      internal.attendanceSecurity.commitKeySetRewrap,
      {
        keySetId: keySet.keySetId,
        eventId: keySet.eventId,
        expected: wrappedEventKey(keySet),
        rewrapped,
      },
    );
    return {
      eventSlug: keySet.eventSlug,
      fromVersion: keySet.wrappingKeyVersion,
      toVersion,
      rewrapped: committed,
    };
  },
});

async function barcodeLookupHash(args: {
  eventKey: Uint8Array;
  kind: "vit_id_barcode" | "external_id_barcode";
  rawValue: string;
  symbology: BarcodeSymbology;
  allowedSymbologies: BarcodeSymbology[];
  normalizationVersion: string;
}) {
  if (!args.allowedSymbologies.some((symbology) => symbology === args.symbology)) {
    throw new ConvexError({
      code: "BARCODE_NOT_ALLOWED",
      message: "This VIT ID barcode format is not enabled for the event.",
    });
  }
  if (args.normalizationVersion !== "trim-v1") {
    throw new ConvexError({
      code: "SCANNER_UPDATE_REQUIRED",
      message:
        "This scanner build is older than the attendance plan. Update the app on this phone.",
    });
  }
  const normalized = args.rawValue.trim();
  if (normalized.length === 0 || normalized.length > 512) {
    throw new ConvexError({
      code: "BARCODE_INVALID",
      message: "The VIT ID barcode could not be read.",
    });
  }
  const key = await crypto.subtle.importKey(
    "raw",
    ownedBytes(args.eventKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    textEncoder.encode(`${args.kind}\0${args.symbology}\0${normalized}`),
  );
  return bytesToHex(new Uint8Array(signature));
}

export async function bearerLookupHash(args: {
  eventKey: Uint8Array;
  kind: "badge_qr" | "external_pass";
  bearer: string;
}) {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(args.bearer)) {
    throw new ConvexError({ code: "QR_INVALID", message: "The attendance QR is invalid." });
  }
  const key = await crypto.subtle.importKey(
    "raw",
    ownedBytes(args.eventKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    textEncoder.encode(`${args.kind}\0${args.bearer}`),
  );
  return bytesToHex(new Uint8Array(signature));
}

async function externalBadgeIdentity(eventKey: Uint8Array, bearer: string) {
  let badgeReference: string;
  try {
    badgeReference = attendanceBadgeReference(bearer);
  } catch {
    throw new ConvexError({ code: "QR_INVALID", message: "The event-badge QR is invalid." });
  }
  return {
    lookupHash: await bearerLookupHash({ eventKey, kind: "badge_qr", bearer }),
    badgeReference,
  };
}

export const registerDevice = action({
  args: {
    eventSlug: v.string(),
    stationId: v.id("attendanceStations"),
    expectedConfigurationVersion: v.number(),
    installationId: v.string(),
    deviceSecret: v.string(),
    name: v.string(),
    platform: v.union(v.literal("android"), v.literal("ios")),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    deviceInstallationId: v.id("attendanceDeviceInstallations"),
    stationId: v.id("attendanceStations"),
  }),
  handler: async (ctx, args): Promise<RegisterDeviceResult> =>
    ctx.runMutation(internal.attendanceSecurity.registerDevice, {
      eventSlug: args.eventSlug,
      stationId: args.stationId,
      expectedConfigurationVersion: args.expectedConfigurationVersion,
      installationId: args.installationId,
      deviceSecretHash: await deviceSecretHash(args.deviceSecret),
      name: args.name,
      platform: args.platform,
      reason: args.reason,
      clientOperationId: args.clientOperationId,
    }),
});

export const scannerHeartbeat = action({
  args: {
    eventSlug: v.string(),
    stationId: v.id("attendanceStations"),
    expectedConfigurationVersion: v.number(),
    deviceInstallationId: v.id("attendanceDeviceInstallations"),
    deviceSecret: v.string(),
    pendingReplayCount: v.number(),
    oldestPendingCapturedAt: v.optional(v.number()),
  },
  returns: v.object({ serverNow: v.number() }),
  handler: async (ctx, args): Promise<ScannerHeartbeatResult> =>
    ctx.runMutation(internal.attendanceSecurity.scannerHeartbeat, {
      eventSlug: args.eventSlug,
      stationId: args.stationId,
      expectedConfigurationVersion: args.expectedConfigurationVersion,
      deviceInstallationId: args.deviceInstallationId,
      deviceSecretHash: await deviceSecretHash(args.deviceSecret),
      pendingReplayCount: args.pendingReplayCount,
      ...(args.oldestPendingCapturedAt !== undefined
        ? { oldestPendingCapturedAt: args.oldestPendingCapturedAt }
        : {}),
    }),
});

export const myExternalPass = action({
  args: { eventSlug: v.string() },
  returns: v.object({
    passId: v.id("attendanceExternalPasses"),
    payload: v.string(),
  }),
  handler: async (ctx, args): Promise<ExternalPassResult> => {
    const bearer = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    const eventKey = await externalPassCredentialKey(ctx, args.eventSlug);
    const lookupHash = await bearerLookupHash({
      eventKey,
      kind: "external_pass",
      bearer,
    });
    const encrypted = await encryptExternalPassBearer(args.eventSlug, eventKey, bearer);
    const result: {
      passId: Id<"attendanceExternalPasses">;
      encryptedBearer: string;
      bearerIv: string;
      bearerAuthTag: string;
      version: number;
    } = await ctx.runMutation(internal.attendanceExternalPasses.ensureMine, {
      eventSlug: args.eventSlug,
      ...encrypted,
      lookupHash,
    });
    const persistedBearer = await decryptExternalPassBearer(args.eventSlug, eventKey, result);
    return {
      passId: result.passId,
      payload: attendanceQrPayload({ kind: "external_pass", bearer: persistedBearer }),
    };
  },
});

export const externalPassForDelivery = internalAction({
  args: {
    eventSlug: v.string(),
    eventId: v.id("events"),
    membershipId: v.id("eventMemberships"),
  },
  returns: v.object({
    passId: v.id("attendanceExternalPasses"),
    payload: v.string(),
  }),
  handler: async (ctx, args): Promise<ExternalPassResult> => {
    const bearer = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    const eventKey = await deliveryCredentialKey(ctx, args.eventSlug, args.membershipId);
    const lookupHash = await bearerLookupHash({ eventKey, kind: "external_pass", bearer });
    const encrypted = await encryptExternalPassBearer(args.eventSlug, eventKey, bearer);
    const result: {
      passId: Id<"attendanceExternalPasses">;
      encryptedBearer: string;
      bearerIv: string;
      bearerAuthTag: string;
      version: number;
    } = await ctx.runMutation(internal.attendanceExternalPasses.ensureForDelivery, {
      eventId: args.eventId,
      membershipId: args.membershipId,
      ...encrypted,
      lookupHash,
    });
    const persistedBearer = await decryptExternalPassBearer(args.eventSlug, eventKey, result);
    return {
      passId: result.passId,
      payload: attendanceQrPayload({ kind: "external_pass", bearer: persistedBearer }),
    };
  },
});

export const externalPassForWallet = internalAction({
  args: { passId: v.string() },
  returns: v.object({
    passId: v.id("attendanceExternalPasses"),
    payload: v.string(),
    eventName: v.string(),
    eventStartsAt: v.number(),
    eventEndsAt: v.number(),
    eventTimezone: v.string(),
    venueName: v.string(),
    participantName: v.string(),
    teamName: v.string(),
  }),
  handler: async (ctx, args): Promise<ExternalPassWalletResult> => {
    const details: ExternalPassWalletDetails = await ctx.runQuery(
      internal.attendanceExternalPasses.detailsForWallet,
      args,
    );
    const eventKey = await existingAttendanceCredentialKey(ctx, details.eventSlug);
    const bearer = await decryptExternalPassBearer(details.eventSlug, eventKey, details);
    return {
      passId: details.passId,
      payload: attendanceQrPayload({ kind: "external_pass", bearer }),
      eventName: details.eventName,
      eventStartsAt: details.eventStartsAt,
      eventEndsAt: details.eventEndsAt,
      eventTimezone: details.eventTimezone,
      venueName: details.venueName,
      participantName: details.participantName,
      teamName: details.teamName,
    };
  },
});

export const beginVitBarcodeEnrollment = action({
  args: {
    eventSlug: v.string(),
    stationId: v.id("attendanceStations"),
    expectedConfigurationVersion: v.number(),
    deviceInstallationId: v.id("attendanceDeviceInstallations"),
    deviceSecret: v.string(),
    resolutionId: v.id("staffedParticipantResolutions"),
    membershipId: v.id("eventMemberships"),
    rawBarcodeValue: v.string(),
    symbology: barcodeSymbology,
    visibleIdentityConfirmed: v.boolean(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    credentialId: v.id("attendanceCredentials"),
    verificationRequired: v.literal(true),
  }),
  handler: async (ctx, args): Promise<BeginEnrollmentResult> => {
    const secretHash = await deviceSecretHash(args.deviceSecret);
    const credential = await credentialKey(ctx, {
      eventSlug: args.eventSlug,
      stationId: args.stationId,
      expectedConfigurationVersion: args.expectedConfigurationVersion,
      deviceInstallationId: args.deviceInstallationId,
      deviceSecretHash: secretHash,
      purpose: "setup",
    });
    const lookupHash = await barcodeLookupHash({
      eventKey: credential.key,
      kind: "vit_id_barcode",
      rawValue: args.rawBarcodeValue,
      symbology: args.symbology,
      allowedSymbologies: credential.barcodeSymbologies,
      normalizationVersion: credential.barcodeNormalizationVersion,
    });
    return ctx.runMutation(internal.attendanceCredentials.beginVitBarcodeEnrollment, {
      eventSlug: args.eventSlug,
      stationId: args.stationId,
      expectedConfigurationVersion: args.expectedConfigurationVersion,
      deviceInstallationId: args.deviceInstallationId,
      deviceSecretHash: secretHash,
      resolutionId: args.resolutionId,
      membershipId: args.membershipId,
      lookupHash,
      symbology: args.symbology,
      normalizationVersion: credential.barcodeNormalizationVersion,
      visibleIdentityConfirmed: args.visibleIdentityConfirmed,
      clientOperationId: args.clientOperationId,
    });
  },
});

const staffedParticipantResultValidator = v.object({
  resolutionId: v.id("staffedParticipantResolutions"),
  membershipId: v.id("eventMemberships"),
  participantClass: v.union(v.literal("vit_student"), v.literal("external_participant")),
  displayName: v.string(),
  institution: v.string(),
  teamName: v.string(),
  vitRegistrationNumber: v.optional(v.string()),
  vitScanRelationship: v.optional(
    v.union(
      v.literal("unbound"),
      v.literal("current_active"),
      v.literal("current_suspended"),
      v.literal("replacement"),
    ),
  ),
  credential: v.union(
    v.object({
      kind: v.literal("vit_id_barcode"),
      state: v.literal("not_enrolled"),
      canEnrol: v.boolean(),
    }),
    v.object({
      kind: v.literal("vit_id_barcode"),
      state: v.union(v.literal("active"), v.literal("suspended")),
      credentialId: v.id("attendanceCredentials"),
      expectedCredentialVersion: v.number(),
      canRebind: v.boolean(),
      canSuspend: v.boolean(),
    }),
    v.object({ kind: v.literal("external_pass"), state: v.literal("active") }),
    v.object({
      kind: v.literal("badge_qr"),
      state: v.literal("not_issued"),
      canIssue: v.boolean(),
    }),
    v.object({
      kind: v.literal("badge_qr"),
      state: v.literal("active"),
      credentialId: v.id("attendanceCredentials"),
      expectedCredentialVersion: v.number(),
      badgeReference: v.string(),
      canReplace: v.boolean(),
      canRevoke: v.boolean(),
    }),
  ),
  venueCheckIn: v.union(
    v.null(),
    v.object({
      id: v.id("venueCheckIns"),
      status: v.union(v.literal("checked_in"), v.literal("reversed")),
      version: v.number(),
      checkedInAt: v.number(),
      stationName: v.string(),
      reversedAt: v.optional(v.number()),
    }),
  ),
  canRecordVenueCheckIn: v.boolean(),
  canOverrideVenueIdentity: v.boolean(),
  canReverseVenueCheckIn: v.boolean(),
});

const staffedParticipantActionArgs = {
  eventSlug: v.string(),
  stationId: v.id("attendanceStations"),
  expectedConfigurationVersion: v.number(),
  deviceInstallationId: v.id("attendanceDeviceInstallations"),
  deviceSecret: v.string(),
};

export const resolveExternalPass = action({
  args: {
    ...staffedParticipantActionArgs,
    passBearer: v.string(),
  },
  returns: staffedParticipantResultValidator,
  handler: async (ctx, args): Promise<StaffedParticipantResult> => {
    const secretHash = await deviceSecretHash(args.deviceSecret);
    const credential = await credentialKey(ctx, {
      eventSlug: args.eventSlug,
      stationId: args.stationId,
      expectedConfigurationVersion: args.expectedConfigurationVersion,
      deviceInstallationId: args.deviceInstallationId,
      deviceSecretHash: secretHash,
      purpose: "setup",
    });
    const lookupHash = await bearerLookupHash({
      eventKey: credential.key,
      kind: "external_pass",
      bearer: args.passBearer,
    });
    return ctx.runMutation(internal.attendanceCredentials.resolveExternalPass, {
      eventSlug: args.eventSlug,
      stationId: args.stationId,
      expectedConfigurationVersion: args.expectedConfigurationVersion,
      deviceInstallationId: args.deviceInstallationId,
      deviceSecretHash: secretHash,
      lookupHash,
    });
  },
});

export const resolveVitBarcode = action({
  args: {
    ...staffedParticipantActionArgs,
    rawBarcodeValue: v.string(),
    symbology: barcodeSymbology,
  },
  returns: staffedParticipantResultValidator,
  handler: async (ctx, args): Promise<StaffedParticipantResult> => {
    const deviceSecret = await deviceSecretHash(args.deviceSecret);
    const credential = await credentialKey(ctx, {
      eventSlug: args.eventSlug,
      stationId: args.stationId,
      expectedConfigurationVersion: args.expectedConfigurationVersion,
      deviceInstallationId: args.deviceInstallationId,
      deviceSecretHash: deviceSecret,
      purpose: "setup",
    });
    const lookupHash = await barcodeLookupHash({
      eventKey: credential.key,
      kind: "vit_id_barcode",
      rawValue: args.rawBarcodeValue,
      symbology: args.symbology,
      allowedSymbologies: credential.barcodeSymbologies,
      normalizationVersion: credential.barcodeNormalizationVersion,
    });
    return ctx.runMutation(internal.attendanceCredentials.resolveVitBarcode, {
      eventSlug: args.eventSlug,
      stationId: args.stationId,
      expectedConfigurationVersion: args.expectedConfigurationVersion,
      deviceInstallationId: args.deviceInstallationId,
      deviceSecretHash: deviceSecret,
      rawRegistrationNumber: args.rawBarcodeValue,
      lookupHash,
      symbology: args.symbology,
    });
  },
});

export const resolveManualParticipant = action({
  args: {
    ...staffedParticipantActionArgs,
    lookup: v.union(
      v.object({ kind: v.literal("vit_registration"), value: v.string() }),
      v.object({ kind: v.literal("external_email"), value: v.string() }),
    ),
  },
  returns: staffedParticipantResultValidator,
  handler: async (ctx, args): Promise<StaffedParticipantResult> =>
    ctx.runMutation(internal.attendanceCredentials.resolveManualParticipant, {
      eventSlug: args.eventSlug,
      stationId: args.stationId,
      expectedConfigurationVersion: args.expectedConfigurationVersion,
      deviceInstallationId: args.deviceInstallationId,
      deviceSecretHash: await deviceSecretHash(args.deviceSecret),
      lookup: args.lookup,
    }),
});

export const enrolResolvedVitBarcode = action({
  args: {
    ...staffedParticipantActionArgs,
    resolutionId: v.id("staffedParticipantResolutions"),
    visibleIdentityConfirmed: v.boolean(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    credentialId: v.id("attendanceCredentials"),
    verified: v.literal(true),
  }),
  handler: async (ctx, args): Promise<VerifyEnrollmentResult> =>
    ctx.runMutation(internal.attendanceCredentials.enrolResolvedVitBarcode, {
      eventSlug: args.eventSlug,
      stationId: args.stationId,
      expectedConfigurationVersion: args.expectedConfigurationVersion,
      deviceInstallationId: args.deviceInstallationId,
      deviceSecretHash: await deviceSecretHash(args.deviceSecret),
      resolutionId: args.resolutionId,
      visibleIdentityConfirmed: args.visibleIdentityConfirmed,
      clientOperationId: args.clientOperationId,
    }),
});

export const linkResolvedExternalIdBarcode = action({
  args: {
    ...staffedParticipantActionArgs,
    resolutionId: v.id("staffedParticipantResolutions"),
    rawBarcodeValue: v.string(),
    symbology: barcodeSymbology,
    visibleIdentityConfirmed: v.boolean(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    bindingId: v.id("attendanceExternalIdentityBindings"),
    verified: v.literal(true),
  }),
  handler: async (ctx, args): Promise<ExternalIdentityLinkResult> => {
    const secretHash = await deviceSecretHash(args.deviceSecret);
    const credential = await credentialKey(ctx, {
      eventSlug: args.eventSlug,
      stationId: args.stationId,
      expectedConfigurationVersion: args.expectedConfigurationVersion,
      deviceInstallationId: args.deviceInstallationId,
      deviceSecretHash: secretHash,
      purpose: "setup",
    });
    const lookupHash = await barcodeLookupHash({
      eventKey: credential.key,
      kind: "external_id_barcode",
      rawValue: args.rawBarcodeValue,
      symbology: args.symbology,
      allowedSymbologies: credential.barcodeSymbologies,
      normalizationVersion: credential.barcodeNormalizationVersion,
    });
    return ctx.runMutation(internal.attendanceCredentials.linkResolvedExternalIdBarcode, {
      eventSlug: args.eventSlug,
      stationId: args.stationId,
      expectedConfigurationVersion: args.expectedConfigurationVersion,
      deviceInstallationId: args.deviceInstallationId,
      deviceSecretHash: secretHash,
      resolutionId: args.resolutionId,
      lookupHash,
      symbology: args.symbology,
      visibleIdentityConfirmed: args.visibleIdentityConfirmed,
      clientOperationId: args.clientOperationId,
    });
  },
});

export const recordVenueCheckIn = action({
  args: {
    eventSlug: v.string(),
    stationId: v.id("attendanceStations"),
    expectedConfigurationVersion: v.number(),
    deviceInstallationId: v.id("attendanceDeviceInstallations"),
    deviceSecret: v.string(),
    resolutionId: v.id("staffedParticipantResolutions"),
    identityCheckKind: v.union(v.literal("class_id"), v.literal("approved_exception")),
    visibleIdentityConfirmed: v.boolean(),
    reason: v.optional(v.string()),
    clientOperationId: v.string(),
  },
  returns: v.object({
    checkInId: v.id("venueCheckIns"),
    status: v.literal("checked_in"),
    checkedInAt: v.number(),
    version: v.number(),
    identityCheckMethod: v.union(
      v.literal("vit_id"),
      v.literal("external_photo_id"),
      v.literal("approved_exception"),
    ),
    teamStatusChanged: v.boolean(),
  }),
  handler: async (ctx, args): Promise<VenueCheckInResult> =>
    ctx.runMutation(internal.attendanceVenueCheckIns.record, {
      eventSlug: args.eventSlug,
      stationId: args.stationId,
      expectedConfigurationVersion: args.expectedConfigurationVersion,
      deviceInstallationId: args.deviceInstallationId,
      deviceSecretHash: await deviceSecretHash(args.deviceSecret),
      resolutionId: args.resolutionId,
      identityCheckKind: args.identityCheckKind,
      visibleIdentityConfirmed: args.visibleIdentityConfirmed,
      ...(args.reason !== undefined ? { reason: args.reason } : {}),
      clientOperationId: args.clientOperationId,
    }),
});

export const reverseVenueCheckIn = action({
  args: {
    eventSlug: v.string(),
    stationId: v.id("attendanceStations"),
    expectedConfigurationVersion: v.number(),
    deviceInstallationId: v.id("attendanceDeviceInstallations"),
    deviceSecret: v.string(),
    resolutionId: v.id("staffedParticipantResolutions"),
    checkInId: v.id("venueCheckIns"),
    expectedCheckInVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    checkInId: v.id("venueCheckIns"),
    status: v.literal("reversed"),
    reversedAt: v.number(),
    version: v.number(),
    teamStatusChanged: v.boolean(),
  }),
  handler: async (ctx, args): Promise<VenueCheckInReversalResult> =>
    ctx.runMutation(internal.attendanceVenueCheckIns.reverse, {
      eventSlug: args.eventSlug,
      stationId: args.stationId,
      expectedConfigurationVersion: args.expectedConfigurationVersion,
      deviceInstallationId: args.deviceInstallationId,
      deviceSecretHash: await deviceSecretHash(args.deviceSecret),
      resolutionId: args.resolutionId,
      checkInId: args.checkInId,
      expectedCheckInVersion: args.expectedCheckInVersion,
      reason: args.reason,
      clientOperationId: args.clientOperationId,
    }),
});

export const verifyVitBarcodeEnrollment = action({
  args: {
    eventSlug: v.string(),
    stationId: v.id("attendanceStations"),
    expectedConfigurationVersion: v.number(),
    deviceInstallationId: v.id("attendanceDeviceInstallations"),
    deviceSecret: v.string(),
    resolutionId: v.id("staffedParticipantResolutions"),
    credentialId: v.id("attendanceCredentials"),
    rawBarcodeValue: v.string(),
    symbology: barcodeSymbology,
    clientOperationId: v.string(),
  },
  returns: v.object({
    credentialId: v.id("attendanceCredentials"),
    verified: v.literal(true),
  }),
  handler: async (ctx, args): Promise<VerifyEnrollmentResult> => {
    const secretHash = await deviceSecretHash(args.deviceSecret);
    const credential = await credentialKey(ctx, {
      eventSlug: args.eventSlug,
      stationId: args.stationId,
      expectedConfigurationVersion: args.expectedConfigurationVersion,
      deviceInstallationId: args.deviceInstallationId,
      deviceSecretHash: secretHash,
      purpose: "setup",
    });
    const lookupHash = await barcodeLookupHash({
      eventKey: credential.key,
      kind: "vit_id_barcode",
      rawValue: args.rawBarcodeValue,
      symbology: args.symbology,
      allowedSymbologies: credential.barcodeSymbologies,
      normalizationVersion: credential.barcodeNormalizationVersion,
    });
    return ctx.runMutation(internal.attendanceCredentials.verifyVitBarcodeEnrollment, {
      eventSlug: args.eventSlug,
      stationId: args.stationId,
      expectedConfigurationVersion: args.expectedConfigurationVersion,
      deviceInstallationId: args.deviceInstallationId,
      deviceSecretHash: secretHash,
      resolutionId: args.resolutionId,
      credentialId: args.credentialId,
      lookupHash,
      symbology: args.symbology,
      clientOperationId: args.clientOperationId,
    });
  },
});

export const beginVitBarcodeRebind = action({
  args: {
    eventSlug: v.string(),
    stationId: v.id("attendanceStations"),
    expectedConfigurationVersion: v.number(),
    deviceInstallationId: v.id("attendanceDeviceInstallations"),
    deviceSecret: v.string(),
    resolutionId: v.id("staffedParticipantResolutions"),
    membershipId: v.id("eventMemberships"),
    priorCredentialId: v.id("attendanceCredentials"),
    expectedPriorCredentialVersion: v.number(),
    rawBarcodeValue: v.string(),
    symbology: barcodeSymbology,
    visibleIdentityConfirmed: v.boolean(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    credentialId: v.id("attendanceCredentials"),
    verificationRequired: v.literal(true),
  }),
  handler: async (ctx, args): Promise<BeginEnrollmentResult> => {
    const secretHash = await deviceSecretHash(args.deviceSecret);
    const credential = await credentialKey(ctx, {
      eventSlug: args.eventSlug,
      stationId: args.stationId,
      expectedConfigurationVersion: args.expectedConfigurationVersion,
      deviceInstallationId: args.deviceInstallationId,
      deviceSecretHash: secretHash,
      purpose: "setup",
    });
    const lookupHash = await barcodeLookupHash({
      eventKey: credential.key,
      kind: "vit_id_barcode",
      rawValue: args.rawBarcodeValue,
      symbology: args.symbology,
      allowedSymbologies: credential.barcodeSymbologies,
      normalizationVersion: credential.barcodeNormalizationVersion,
    });
    return ctx.runMutation(internal.attendanceCredentials.beginVitBarcodeRebind, {
      eventSlug: args.eventSlug,
      stationId: args.stationId,
      expectedConfigurationVersion: args.expectedConfigurationVersion,
      deviceInstallationId: args.deviceInstallationId,
      deviceSecretHash: secretHash,
      resolutionId: args.resolutionId,
      membershipId: args.membershipId,
      priorCredentialId: args.priorCredentialId,
      expectedPriorCredentialVersion: args.expectedPriorCredentialVersion,
      lookupHash,
      symbology: args.symbology,
      normalizationVersion: credential.barcodeNormalizationVersion,
      visibleIdentityConfirmed: args.visibleIdentityConfirmed,
      reason: args.reason,
      clientOperationId: args.clientOperationId,
    });
  },
});

export const verifyVitBarcodeRebind = action({
  args: {
    eventSlug: v.string(),
    stationId: v.id("attendanceStations"),
    expectedConfigurationVersion: v.number(),
    deviceInstallationId: v.id("attendanceDeviceInstallations"),
    deviceSecret: v.string(),
    resolutionId: v.id("staffedParticipantResolutions"),
    membershipId: v.id("eventMemberships"),
    priorCredentialId: v.id("attendanceCredentials"),
    expectedPriorCredentialVersion: v.number(),
    replacementCredentialId: v.id("attendanceCredentials"),
    rawBarcodeValue: v.string(),
    symbology: barcodeSymbology,
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    credentialId: v.id("attendanceCredentials"),
    replacedCredentialId: v.id("attendanceCredentials"),
    verified: v.literal(true),
  }),
  handler: async (ctx, args): Promise<VerifyReplacementResult> => {
    const secretHash = await deviceSecretHash(args.deviceSecret);
    const credential = await credentialKey(ctx, {
      eventSlug: args.eventSlug,
      stationId: args.stationId,
      expectedConfigurationVersion: args.expectedConfigurationVersion,
      deviceInstallationId: args.deviceInstallationId,
      deviceSecretHash: secretHash,
      purpose: "setup",
    });
    const lookupHash = await barcodeLookupHash({
      eventKey: credential.key,
      kind: "vit_id_barcode",
      rawValue: args.rawBarcodeValue,
      symbology: args.symbology,
      allowedSymbologies: credential.barcodeSymbologies,
      normalizationVersion: credential.barcodeNormalizationVersion,
    });
    return ctx.runMutation(internal.attendanceCredentials.verifyVitBarcodeRebind, {
      eventSlug: args.eventSlug,
      stationId: args.stationId,
      expectedConfigurationVersion: args.expectedConfigurationVersion,
      deviceInstallationId: args.deviceInstallationId,
      deviceSecretHash: secretHash,
      resolutionId: args.resolutionId,
      membershipId: args.membershipId,
      priorCredentialId: args.priorCredentialId,
      expectedPriorCredentialVersion: args.expectedPriorCredentialVersion,
      replacementCredentialId: args.replacementCredentialId,
      lookupHash,
      symbology: args.symbology,
      reason: args.reason,
      clientOperationId: args.clientOperationId,
    });
  },
});

export const suspendVitBarcode = action({
  args: {
    eventSlug: v.string(),
    stationId: v.id("attendanceStations"),
    expectedConfigurationVersion: v.number(),
    deviceInstallationId: v.id("attendanceDeviceInstallations"),
    deviceSecret: v.string(),
    resolutionId: v.id("staffedParticipantResolutions"),
    membershipId: v.id("eventMemberships"),
    credentialId: v.id("attendanceCredentials"),
    expectedCredentialVersion: v.number(),
    visibleIdentityConfirmed: v.boolean(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    credentialId: v.id("attendanceCredentials"),
    suspended: v.literal(true),
  }),
  handler: async (ctx, args): Promise<SuspendVitResult> =>
    ctx.runMutation(internal.attendanceCredentials.suspendVitBarcode, {
      eventSlug: args.eventSlug,
      stationId: args.stationId,
      expectedConfigurationVersion: args.expectedConfigurationVersion,
      deviceInstallationId: args.deviceInstallationId,
      deviceSecretHash: await deviceSecretHash(args.deviceSecret),
      resolutionId: args.resolutionId,
      membershipId: args.membershipId,
      credentialId: args.credentialId,
      expectedCredentialVersion: args.expectedCredentialVersion,
      visibleIdentityConfirmed: args.visibleIdentityConfirmed,
      reason: args.reason,
      clientOperationId: args.clientOperationId,
    }),
});

export const beginExternalBadgeIssue = action({
  args: {
    eventSlug: v.string(),
    stationId: v.id("attendanceStations"),
    expectedConfigurationVersion: v.number(),
    deviceInstallationId: v.id("attendanceDeviceInstallations"),
    deviceSecret: v.string(),
    resolutionId: v.id("staffedParticipantResolutions"),
    membershipId: v.id("eventMemberships"),
    badgeBearer: v.string(),
    visibleIdentityConfirmed: v.boolean(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    credentialId: v.id("attendanceCredentials"),
    badgeReference: v.string(),
    verificationRequired: v.literal(true),
  }),
  handler: async (ctx, args): Promise<BeginBadgeResult> => {
    const secretHash = await deviceSecretHash(args.deviceSecret);
    const credential = await credentialKey(ctx, {
      eventSlug: args.eventSlug,
      stationId: args.stationId,
      expectedConfigurationVersion: args.expectedConfigurationVersion,
      deviceInstallationId: args.deviceInstallationId,
      deviceSecretHash: secretHash,
      purpose: "setup",
    });
    const badge = await externalBadgeIdentity(credential.key, args.badgeBearer);
    return ctx.runMutation(internal.attendanceCredentials.beginExternalBadgeIssue, {
      eventSlug: args.eventSlug,
      stationId: args.stationId,
      expectedConfigurationVersion: args.expectedConfigurationVersion,
      deviceInstallationId: args.deviceInstallationId,
      deviceSecretHash: secretHash,
      resolutionId: args.resolutionId,
      membershipId: args.membershipId,
      lookupHash: badge.lookupHash,
      badgeReference: badge.badgeReference,
      visibleIdentityConfirmed: args.visibleIdentityConfirmed,
      clientOperationId: args.clientOperationId,
    });
  },
});

export const verifyExternalBadgeIssue = action({
  args: {
    eventSlug: v.string(),
    stationId: v.id("attendanceStations"),
    expectedConfigurationVersion: v.number(),
    deviceInstallationId: v.id("attendanceDeviceInstallations"),
    deviceSecret: v.string(),
    resolutionId: v.id("staffedParticipantResolutions"),
    membershipId: v.id("eventMemberships"),
    credentialId: v.id("attendanceCredentials"),
    badgeBearer: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    credentialId: v.id("attendanceCredentials"),
    badgeReference: v.string(),
    verified: v.literal(true),
  }),
  handler: async (ctx, args): Promise<VerifyBadgeResult> => {
    const secretHash = await deviceSecretHash(args.deviceSecret);
    const credential = await credentialKey(ctx, {
      eventSlug: args.eventSlug,
      stationId: args.stationId,
      expectedConfigurationVersion: args.expectedConfigurationVersion,
      deviceInstallationId: args.deviceInstallationId,
      deviceSecretHash: secretHash,
      purpose: "setup",
    });
    const badge = await externalBadgeIdentity(credential.key, args.badgeBearer);
    return ctx.runMutation(internal.attendanceCredentials.verifyExternalBadgeIssue, {
      eventSlug: args.eventSlug,
      stationId: args.stationId,
      expectedConfigurationVersion: args.expectedConfigurationVersion,
      deviceInstallationId: args.deviceInstallationId,
      deviceSecretHash: secretHash,
      resolutionId: args.resolutionId,
      membershipId: args.membershipId,
      credentialId: args.credentialId,
      lookupHash: badge.lookupHash,
      badgeReference: badge.badgeReference,
      clientOperationId: args.clientOperationId,
    });
  },
});

export const beginExternalBadgeReplacement = action({
  args: {
    eventSlug: v.string(),
    stationId: v.id("attendanceStations"),
    expectedConfigurationVersion: v.number(),
    deviceInstallationId: v.id("attendanceDeviceInstallations"),
    deviceSecret: v.string(),
    resolutionId: v.id("staffedParticipantResolutions"),
    membershipId: v.id("eventMemberships"),
    priorCredentialId: v.id("attendanceCredentials"),
    expectedPriorCredentialVersion: v.number(),
    badgeBearer: v.string(),
    visibleIdentityConfirmed: v.boolean(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    credentialId: v.id("attendanceCredentials"),
    badgeReference: v.string(),
    verificationRequired: v.literal(true),
  }),
  handler: async (ctx, args): Promise<BeginBadgeResult> => {
    const secretHash = await deviceSecretHash(args.deviceSecret);
    const credential = await credentialKey(ctx, {
      eventSlug: args.eventSlug,
      stationId: args.stationId,
      expectedConfigurationVersion: args.expectedConfigurationVersion,
      deviceInstallationId: args.deviceInstallationId,
      deviceSecretHash: secretHash,
      purpose: "setup",
    });
    const badge = await externalBadgeIdentity(credential.key, args.badgeBearer);
    return ctx.runMutation(internal.attendanceCredentials.beginExternalBadgeReplacement, {
      eventSlug: args.eventSlug,
      stationId: args.stationId,
      expectedConfigurationVersion: args.expectedConfigurationVersion,
      deviceInstallationId: args.deviceInstallationId,
      deviceSecretHash: secretHash,
      resolutionId: args.resolutionId,
      membershipId: args.membershipId,
      priorCredentialId: args.priorCredentialId,
      expectedPriorCredentialVersion: args.expectedPriorCredentialVersion,
      lookupHash: badge.lookupHash,
      badgeReference: badge.badgeReference,
      visibleIdentityConfirmed: args.visibleIdentityConfirmed,
      reason: args.reason,
      clientOperationId: args.clientOperationId,
    });
  },
});

export const verifyExternalBadgeReplacement = action({
  args: {
    eventSlug: v.string(),
    stationId: v.id("attendanceStations"),
    expectedConfigurationVersion: v.number(),
    deviceInstallationId: v.id("attendanceDeviceInstallations"),
    deviceSecret: v.string(),
    resolutionId: v.id("staffedParticipantResolutions"),
    membershipId: v.id("eventMemberships"),
    priorCredentialId: v.id("attendanceCredentials"),
    expectedPriorCredentialVersion: v.number(),
    replacementCredentialId: v.id("attendanceCredentials"),
    badgeBearer: v.string(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    credentialId: v.id("attendanceCredentials"),
    replacedCredentialId: v.id("attendanceCredentials"),
    badgeReference: v.string(),
    verified: v.literal(true),
  }),
  handler: async (ctx, args): Promise<VerifyBadgeReplacementResult> => {
    const secretHash = await deviceSecretHash(args.deviceSecret);
    const credential = await credentialKey(ctx, {
      eventSlug: args.eventSlug,
      stationId: args.stationId,
      expectedConfigurationVersion: args.expectedConfigurationVersion,
      deviceInstallationId: args.deviceInstallationId,
      deviceSecretHash: secretHash,
      purpose: "setup",
    });
    const badge = await externalBadgeIdentity(credential.key, args.badgeBearer);
    return ctx.runMutation(internal.attendanceCredentials.verifyExternalBadgeReplacement, {
      eventSlug: args.eventSlug,
      stationId: args.stationId,
      expectedConfigurationVersion: args.expectedConfigurationVersion,
      deviceInstallationId: args.deviceInstallationId,
      deviceSecretHash: secretHash,
      resolutionId: args.resolutionId,
      membershipId: args.membershipId,
      priorCredentialId: args.priorCredentialId,
      expectedPriorCredentialVersion: args.expectedPriorCredentialVersion,
      replacementCredentialId: args.replacementCredentialId,
      lookupHash: badge.lookupHash,
      badgeReference: badge.badgeReference,
      reason: args.reason,
      clientOperationId: args.clientOperationId,
    });
  },
});

export const revokeExternalBadge = action({
  args: {
    eventSlug: v.string(),
    stationId: v.id("attendanceStations"),
    expectedConfigurationVersion: v.number(),
    deviceInstallationId: v.id("attendanceDeviceInstallations"),
    deviceSecret: v.string(),
    resolutionId: v.id("staffedParticipantResolutions"),
    membershipId: v.id("eventMemberships"),
    credentialId: v.id("attendanceCredentials"),
    expectedCredentialVersion: v.number(),
    visibleIdentityConfirmed: v.boolean(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    credentialId: v.id("attendanceCredentials"),
    revoked: v.literal(true),
  }),
  handler: async (ctx, args): Promise<RevokeBadgeResult> =>
    ctx.runMutation(internal.attendanceCredentials.revokeExternalBadge, {
      eventSlug: args.eventSlug,
      stationId: args.stationId,
      expectedConfigurationVersion: args.expectedConfigurationVersion,
      deviceInstallationId: args.deviceInstallationId,
      deviceSecretHash: await deviceSecretHash(args.deviceSecret),
      resolutionId: args.resolutionId,
      membershipId: args.membershipId,
      credentialId: args.credentialId,
      expectedCredentialVersion: args.expectedCredentialVersion,
      visibleIdentityConfirmed: args.visibleIdentityConfirmed,
      reason: args.reason,
      clientOperationId: args.clientOperationId,
    }),
});

export const recordScan = action({
  args: {
    eventSlug: v.string(),
    stationId: v.id("attendanceStations"),
    expectedConfigurationVersion: v.number(),
    deviceInstallationId: v.id("attendanceDeviceInstallations"),
    deviceSecret: v.string(),
    credential: v.union(
      v.object({
        kind: v.literal("vit_id_barcode"),
        rawBarcodeValue: v.string(),
        symbology: barcodeSymbology,
      }),
      v.object({ kind: v.literal("badge_qr"), bearer: v.string() }),
      v.object({ kind: v.literal("external_pass"), bearer: v.string() }),
    ),
    rovingTransition: v.optional(attendanceScanTransition),
    clientOperationId: v.string(),
    deviceSequence: v.number(),
    capturedAt: v.number(),
    isOfflineReplay: v.boolean(),
  },
  returns: v.object({
    presenceEventId: v.id("attendancePresenceEvents"),
    outcome: v.union(
      v.literal("accepted"),
      v.literal("duplicate"),
      v.literal("rejected"),
      v.literal("needs_review"),
    ),
    reasonCode: v.string(),
    serverTime: v.number(),
    transition: attendanceScanTransition,
    previousState: v.optional(v.string()),
    nextState: v.optional(v.string()),
    participant: v.union(
      v.null(),
      v.object({
        membershipId: v.id("eventMemberships"),
        displayName: v.string(),
        teamName: v.optional(v.string()),
        vitRegistrationNumber: v.optional(v.string()),
      }),
    ),
  }),
  handler: async (ctx, args): Promise<ScanReceipt> => {
    const secretHash = await deviceSecretHash(args.deviceSecret);
    const key = await credentialKey(ctx, {
      eventSlug: args.eventSlug,
      stationId: args.stationId,
      expectedConfigurationVersion: args.expectedConfigurationVersion,
      deviceInstallationId: args.deviceInstallationId,
      deviceSecretHash: secretHash,
      purpose: "scan",
    });
    const lookupHash =
      args.credential.kind === "vit_id_barcode"
        ? await barcodeLookupHash({
            eventKey: key.key,
            kind: "vit_id_barcode",
            rawValue: args.credential.rawBarcodeValue,
            symbology: args.credential.symbology,
            allowedSymbologies: key.barcodeSymbologies,
            normalizationVersion: key.barcodeNormalizationVersion,
          })
        : await bearerLookupHash({
            eventKey: key.key,
            kind: args.credential.kind,
            bearer: args.credential.bearer,
          });
    return ctx.runMutation(internal.attendanceScan.recordScan, {
      eventSlug: args.eventSlug,
      stationId: args.stationId,
      expectedConfigurationVersion: args.expectedConfigurationVersion,
      deviceInstallationId: args.deviceInstallationId,
      deviceSecretHash: secretHash,
      credentialKind: args.credential.kind,
      lookupHash,
      ...(args.rovingTransition !== undefined ? { rovingTransition: args.rovingTransition } : {}),
      clientOperationId: args.clientOperationId,
      deviceSequence: args.deviceSequence,
      capturedAt: args.capturedAt,
      isOfflineReplay: args.isOfflineReplay,
    });
  },
});

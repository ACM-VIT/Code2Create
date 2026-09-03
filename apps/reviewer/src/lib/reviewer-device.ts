import { randomUUID } from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { z } from "zod";

import { notifyInstallationChanged } from "./installation-state";

const reviewerRegistrationAttemptSchema = z
  .object({
    clientOperationId: z.uuid(),
    appBuild: z.number().int().positive(),
    cameraReady: z.boolean(),
    encryptedDraftReady: z.boolean(),
    expectedVersion: z.number().int().nonnegative(),
    push: z
      .object({
        token: z.string().min(1),
        provider: z.enum(["fcm", "apns"]),
        environment: z.enum(["development", "production"]),
      })
      .strict()
      .optional(),
  })
  .strict();

const reviewerDeviceSchema = z
  .object({
    version: z.literal(2),
    installationId: z.uuid(),
    deviceName: z.string().min(2).max(80),
    platform: z.enum(["android", "ios"]),
    registrationAttempt: reviewerRegistrationAttemptSchema.optional(),
  })
  .strict();

export type ReviewerDeviceRecord = z.infer<typeof reviewerDeviceSchema>;
export type ReviewerPlatform = ReviewerDeviceRecord["platform"];
export type ReviewerRegistrationInput = Omit<
  z.infer<typeof reviewerRegistrationAttemptSchema>,
  "clientOperationId"
>;

function storageKey(eventSlug: string) {
  return `code2create.reviewer.${eventSlug}`;
}

export async function loadReviewerDevice(eventSlug: string) {
  const stored = await SecureStore.getItemAsync(storageKey(eventSlug));
  if (!stored) return null;
  const decoded: unknown = JSON.parse(stored);
  const parsed = reviewerDeviceSchema.safeParse(decoded);
  if (parsed.success) return parsed.data;
  throw new Error(
    "The reviewer setup stored on this phone is invalid. Ask operations to reprovision it.",
  );
}

export async function createReviewerDevice(eventSlug: string, platform: ReviewerPlatform) {
  const installationId = randomUUID();
  const record: ReviewerDeviceRecord = {
    version: 2,
    installationId,
    deviceName: `Reviewer ${installationId.slice(-4)}`,
    platform,
  };
  await saveReviewerDevice(eventSlug, record);
  return record;
}

export async function prepareReviewerRegistration(
  eventSlug: string,
  record: ReviewerDeviceRecord,
  input: ReviewerRegistrationInput,
) {
  if (record.registrationAttempt) {
    return { record, attempt: record.registrationAttempt };
  }
  const attempt = {
    ...input,
    clientOperationId: randomUUID(),
  };
  const next: ReviewerDeviceRecord = {
    ...record,
    registrationAttempt: attempt,
  };
  await saveReviewerDevice(eventSlug, next);
  return { record: next, attempt };
}

export async function clearReviewerRegistration(
  eventSlug: string,
  record: ReviewerDeviceRecord,
  clientOperationId: string,
) {
  if (record.registrationAttempt?.clientOperationId !== clientOperationId) return record;
  const next: ReviewerDeviceRecord = {
    version: 2,
    installationId: record.installationId,
    deviceName: record.deviceName,
    platform: record.platform,
  };
  await saveReviewerDevice(eventSlug, next);
  return next;
}

export async function clearReviewerDevice(eventSlug: string) {
  await SecureStore.deleteItemAsync(storageKey(eventSlug));
  notifyInstallationChanged(eventSlug);
}

async function saveReviewerDevice(eventSlug: string, record: ReviewerDeviceRecord) {
  await SecureStore.setItemAsync(storageKey(eventSlug), JSON.stringify(record));
  notifyInstallationChanged(eventSlug);
}

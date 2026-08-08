import { randomUUID } from 'expo-crypto'
import * as SecureStore from 'expo-secure-store'
import { z } from 'zod'

const reviewerDeviceSchema = z
  .object({
    version: z.literal(1),
    installationId: z.uuid(),
    registrationOperationId: z.uuid(),
    deviceName: z.string().min(2).max(80),
    platform: z.enum(['android', 'ios']),
  })
  .strict()

export type ReviewerDeviceRecord = z.infer<typeof reviewerDeviceSchema>
export type ReviewerPlatform = ReviewerDeviceRecord['platform']

function storageKey(eventSlug: string) {
  return `code2create.reviewer.${eventSlug}`
}

export async function loadReviewerDevice(eventSlug: string) {
  const stored = await SecureStore.getItemAsync(storageKey(eventSlug))
  if (!stored) return null
  const decoded: unknown = JSON.parse(stored)
  const parsed = reviewerDeviceSchema.safeParse(decoded)
  if (!parsed.success) {
    throw new Error('The reviewer setup stored on this phone is invalid. Ask operations to reprovision it.')
  }
  return parsed.data
}

export async function createReviewerDevice(eventSlug: string, platform: ReviewerPlatform) {
  const installationId = randomUUID()
  const record: ReviewerDeviceRecord = {
    version: 1,
    installationId,
    registrationOperationId: randomUUID(),
    deviceName: `Reviewer ${installationId.slice(-4)}`,
    platform,
  }
  await saveReviewerDevice(eventSlug, record)
  return record
}

export async function rotateReviewerRegistration(
  eventSlug: string,
  record: ReviewerDeviceRecord,
) {
  const next: ReviewerDeviceRecord = {
    ...record,
    registrationOperationId: randomUUID(),
  }
  await saveReviewerDevice(eventSlug, next)
  return next
}

async function saveReviewerDevice(eventSlug: string, record: ReviewerDeviceRecord) {
  await SecureStore.setItemAsync(storageKey(eventSlug), JSON.stringify(record))
}

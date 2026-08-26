import { getRandomBytesAsync, randomUUID } from 'expo-crypto'
import * as SecureStore from 'expo-secure-store'
import { z } from 'zod'

import { notifyInstallationChanged } from './installation-state'

const scannerDeviceSchema = z
  .object({
    version: z.literal(1),
    installationId: z.uuid(),
    deviceSecret: z.string().regex(/^[a-f0-9]{64}$/u),
    registrationOperationId: z.uuid(),
    stationStableKey: z.string().min(1).max(100),
    deviceName: z.string().min(2).max(80),
    platform: z.enum(['android', 'ios']),
    lastIssuedSequence: z.number().int().nonnegative(),
  })
  .strict()

export type ScannerDeviceRecord = z.infer<typeof scannerDeviceSchema>
export type ScannerPlatform = ScannerDeviceRecord['platform']

function storageKey(eventSlug: string) {
  return `code2create.scanner.${eventSlug}`
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function loadScannerDevice(eventSlug: string) {
  const stored = await SecureStore.getItemAsync(storageKey(eventSlug))
  if (!stored) return null
  let decoded: unknown
  try {
    decoded = JSON.parse(stored)
  } catch {
    throw invalidScannerSetupError()
  }
  const parsed = scannerDeviceSchema.safeParse(decoded)
  if (!parsed.success) {
    throw invalidScannerSetupError()
  }
  return parsed.data
}

function invalidScannerSetupError() {
  return new Error('The scanner setup stored on this phone is invalid. Ask operations to reprovision it.')
}

export async function createScannerDevice(args: {
  eventSlug: string
  stationStableKey: string
  platform: ScannerPlatform
}) {
  const installationId = randomUUID()
  const record: ScannerDeviceRecord = {
    version: 1,
    installationId,
    deviceSecret: bytesToHex(await getRandomBytesAsync(32)),
    registrationOperationId: randomUUID(),
    stationStableKey: args.stationStableKey,
    deviceName: `Scanner ${installationId.slice(-4)}`,
    platform: args.platform,
    lastIssuedSequence: 0,
  }
  await saveScannerDevice(args.eventSlug, record)
  return record
}

export async function saveScannerDevice(eventSlug: string, record: ScannerDeviceRecord) {
  await SecureStore.setItemAsync(storageKey(eventSlug), JSON.stringify(record))
  notifyInstallationChanged(eventSlug)
}

export async function clearScannerDevice(eventSlug: string) {
  await SecureStore.deleteItemAsync(storageKey(eventSlug))
  notifyInstallationChanged(eventSlug)
}

export async function reserveDeviceSequence(args: {
  eventSlug: string
  record: ScannerDeviceRecord
  serverSequence: number
}) {
  const next: ScannerDeviceRecord = {
    ...args.record,
    lastIssuedSequence: Math.max(args.record.lastIssuedSequence, args.serverSequence) + 1,
  }
  await saveScannerDevice(args.eventSlug, next)
  return next
}

import { barcodeSymbologies } from '@code2create/domain'
import * as SQLite from 'expo-sqlite'
import { z } from 'zod'

import { encryptedLocalDatabase } from './encrypted-local-database'

const bearerPattern = /^[A-Za-z0-9_-]{43}$/u
const pendingCredentialSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('vit_id_barcode'),
      rawBarcodeValue: z.string().min(1).max(512),
      symbology: z.enum(barcodeSymbologies),
    })
    .strict(),
  z.object({ kind: z.literal('badge_qr'), bearer: z.string().regex(bearerPattern) }).strict(),
  z.object({ kind: z.literal('portal_qr'), bearer: z.string().regex(bearerPattern) }).strict(),
])
const scanTransitionSchema = z.enum([
  'venue_entry',
  'venue_exit',
  'session_confirm',
  'zone_entry',
  'zone_exit',
])
const pendingAttendanceScanSchema = z
  .object({
    version: z.literal(1),
    eventSlug: z.string().regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/u),
    installationId: z.uuid(),
    stationStableKey: z.string().regex(/^[a-z0-9]+(?:_[a-z0-9]+)*$/u),
    expectedConfigurationVersion: z.number().int().positive(),
    credential: pendingCredentialSchema,
    transition: scanTransitionSchema,
    clientOperationId: z.uuid(),
    deviceSequence: z.number().int().positive(),
    capturedAt: z.number().int().positive(),
    expiresAt: z.number().int().positive(),
  })
  .strict()
const countRowSchema = z.object({ count: z.number().int().nonnegative() })
const payloadRowSchema = z.object({ payload: z.string() })

export type ScanTransition = z.infer<typeof scanTransitionSchema>
export type PendingAttendanceScan = z.infer<typeof pendingAttendanceScanSchema>
export type PendingAttendanceScanInput = Omit<PendingAttendanceScan, 'version' | 'expiresAt'>
export type PendingAttendanceSummary = {
  count: number
  oldestCapturedAt?: number
}

const queueDatabasePromises = new Map<string, Promise<SQLite.SQLiteDatabase>>()

export class PendingAttendanceQueueFullError extends Error {
  constructor() {
    super('This phone’s encrypted pending-scan queue is full. Move to an online station.')
    this.name = 'PendingAttendanceQueueFullError'
  }
}

export async function enqueuePendingAttendanceScan(args: {
  input: PendingAttendanceScanInput
  maxScans: number
  maxAgeSeconds: number
  now: number
}) {
  requireQueuePolicy(args.maxScans, args.maxAgeSeconds)
  const record = pendingAttendanceScanSchema.parse({
    version: 1,
    ...args.input,
    expiresAt: args.now + args.maxAgeSeconds * 1_000,
  })
  const database = await queueDatabase(record.eventSlug)
  await database.withExclusiveTransactionAsync(async (transaction) => {
    await deleteExpired(transaction, record.eventSlug, record.installationId, args.now)
    const count = await queueCount(transaction, record.eventSlug, record.installationId)
    if (count >= args.maxScans) throw new PendingAttendanceQueueFullError()
    await transaction.runAsync(
      `INSERT INTO pending_attendance_scans
        (event_slug, installation_id, device_sequence, expires_at, payload)
       VALUES (?, ?, ?, ?, ?)`,
      record.eventSlug,
      record.installationId,
      record.deviceSequence,
      record.expiresAt,
      JSON.stringify(record),
    )
  })
  return record
}

export async function loadPendingAttendanceScans(args: {
  eventSlug: string
  installationId: string
  now: number
}) {
  const database = await queueDatabase(args.eventSlug)
  let records: PendingAttendanceScan[] = []
  await database.withExclusiveTransactionAsync(async (transaction) => {
    await deleteExpired(transaction, args.eventSlug, args.installationId, args.now)
    const rows: unknown[] = await transaction.getAllAsync<unknown>(
      `SELECT payload FROM pending_attendance_scans
       WHERE event_slug = ? AND installation_id = ?
       ORDER BY device_sequence ASC`,
      args.eventSlug,
      args.installationId,
    )
    records = rows.map((row) => {
      const payloadRow = payloadRowSchema.parse(row)
      const decoded: unknown = JSON.parse(payloadRow.payload)
      const record = pendingAttendanceScanSchema.parse(decoded)
      if (record.eventSlug !== args.eventSlug || record.installationId !== args.installationId) {
        throw new Error('The encrypted pending-scan queue contains a foreign record.')
      }
      return record
    })
  })
  return records
}

export async function removePendingAttendanceScan(args: {
  eventSlug: string
  installationId: string
  deviceSequence: number
}) {
  const database = await queueDatabase(args.eventSlug)
  await database.runAsync(
    `DELETE FROM pending_attendance_scans
     WHERE event_slug = ? AND installation_id = ? AND device_sequence = ?`,
    args.eventSlug,
    args.installationId,
    args.deviceSequence,
  )
}

export async function clearPendingAttendanceScans(args: {
  eventSlug: string
  installationId: string
}) {
  const database = await queueDatabase(args.eventSlug)
  await database.runAsync(
    'DELETE FROM pending_attendance_scans WHERE event_slug = ? AND installation_id = ?',
    args.eventSlug,
    args.installationId,
  )
}

export async function pendingAttendanceSummary(args: {
  eventSlug: string
  installationId: string
  now: number
}): Promise<PendingAttendanceSummary> {
  const records = await loadPendingAttendanceScans(args)
  const oldest = records.at(0)
  return oldest ? { count: records.length, oldestCapturedAt: oldest.capturedAt } : { count: 0 }
}

function queueDatabase(eventSlug: string) {
  const existing = queueDatabasePromises.get(eventSlug)
  if (existing) return existing
  const initializing = initializeQueueDatabase(eventSlug)
  queueDatabasePromises.set(eventSlug, initializing)
  void initializing.catch(() => {
    if (queueDatabasePromises.get(eventSlug) === initializing) {
      queueDatabasePromises.delete(eventSlug)
    }
  })
  return initializing
}

async function initializeQueueDatabase(eventSlug: string) {
  const database = await encryptedLocalDatabase(eventSlug)
  await database.execAsync(`
    CREATE TABLE IF NOT EXISTS pending_attendance_scans (
      event_slug TEXT NOT NULL,
      installation_id TEXT NOT NULL,
      device_sequence INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      payload TEXT NOT NULL,
      PRIMARY KEY (event_slug, installation_id, device_sequence)
    );
    CREATE INDEX IF NOT EXISTS pending_attendance_scans_by_expiry
      ON pending_attendance_scans (event_slug, installation_id, expires_at);
  `)
  return database
}

async function deleteExpired(
  database: SQLite.SQLiteDatabase,
  eventSlug: string,
  installationId: string,
  now: number,
) {
  await database.runAsync(
    `DELETE FROM pending_attendance_scans
     WHERE event_slug = ? AND installation_id = ? AND expires_at <= ?`,
    eventSlug,
    installationId,
    now,
  )
}

async function queueCount(
  database: SQLite.SQLiteDatabase,
  eventSlug: string,
  installationId: string,
) {
  const row: unknown = await database.getFirstAsync<unknown>(
    `SELECT COUNT(*) AS count FROM pending_attendance_scans
     WHERE event_slug = ? AND installation_id = ?`,
    eventSlug,
    installationId,
  )
  return countRowSchema.parse(row).count
}

function requireQueuePolicy(maxScans: number, maxAgeSeconds: number) {
  if (!Number.isInteger(maxScans) || maxScans < 1 || maxScans > 25) {
    throw new Error('The offline queue size is outside the supported range.')
  }
  if (!Number.isInteger(maxAgeSeconds) || maxAgeSeconds < 30 || maxAgeSeconds > 600) {
    throw new Error('The offline queue age is outside the supported range.')
  }
}

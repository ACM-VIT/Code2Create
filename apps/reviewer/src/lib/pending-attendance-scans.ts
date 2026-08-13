import { barcodeSymbologies } from '@code2create/domain'
import * as SQLite from 'expo-sqlite'
import { z } from 'zod'

import { attendanceScanTransitions } from './attendance-station-policy'
import {
  resetEncryptedLocalDatabase,
  unreadableStore,
  withEncryptedLocalDatabase,
} from './encrypted-local-database'
import { OperatorError } from './errors'

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
const scanTransitionSchema = z.enum(attendanceScanTransitions)
const pendingAttendanceScanSchema = z
  .object({
    version: z.literal(1),
    eventSlug: z.string().regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/u),
    installationId: z.uuid(),
    stationStableKey: z.string().regex(/^[a-z0-9]+(?:_[a-z0-9]+)*$/u),
    expectedConfigurationVersion: z.number().int().positive(),
    credential: pendingCredentialSchema,
    rovingTransition: scanTransitionSchema.optional(),
    clientOperationId: z.uuid(),
    deviceSequence: z.number().int().positive(),
    capturedAt: z.number().int().positive(),
    expiresAt: z.number().int().positive(),
  })
  .strict()
const countRowSchema = z.object({ count: z.number().int().nonnegative() })
const payloadRowSchema = z.object({ payload: z.string() })

export type PendingAttendanceScan = z.infer<typeof pendingAttendanceScanSchema>
export type PendingAttendanceScanInput = Omit<PendingAttendanceScan, 'version' | 'expiresAt'>
export type PendingAttendanceSummary = {
  count: number
  oldestCapturedAt?: number
}

/** A recoverable queue-capacity error with operator-facing text. */
export class PendingAttendanceQueueFullError extends OperatorError {
  constructor() {
    super('This phone is holding as many unsent scans as it can. Move to a door with signal so they can go through.')
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
  await onQueue(record.eventSlug, (database) =>
    inWriteTransaction(database, async () => {
      await deleteExpired(database, record.eventSlug, record.installationId, args.now)
      const count = await queueCount(database, record.eventSlug, record.installationId)
      if (count >= args.maxScans) throw new PendingAttendanceQueueFullError()
      await database.runAsync(
        `INSERT INTO pending_attendance_scans
          (event_slug, installation_id, device_sequence, expires_at, payload)
         VALUES (?, ?, ?, ?, ?)`,
        record.eventSlug,
        record.installationId,
        record.deviceSequence,
        record.expiresAt,
        JSON.stringify(record),
      )
    }),
  )
  return record
}

export async function loadPendingAttendanceScans(args: {
  eventSlug: string
  installationId: string
  now: number
}) {
  let records: PendingAttendanceScan[] = []
  await onQueue(args.eventSlug, (database) =>
    inWriteTransaction(database, async () => {
      await deleteExpired(database, args.eventSlug, args.installationId, args.now)
      const rows: unknown[] = await database.getAllAsync<unknown>(
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
    }),
  )
  return records
}

export async function removePendingAttendanceScan(args: {
  eventSlug: string
  installationId: string
  deviceSequence: number
}) {
  await onQueue(args.eventSlug, (database) =>
    database.runAsync(
      `DELETE FROM pending_attendance_scans
       WHERE event_slug = ? AND installation_id = ? AND device_sequence = ?`,
      args.eventSlug,
      args.installationId,
      args.deviceSequence,
    ),
  )
}

export async function clearPendingAttendanceScans(args: {
  eventSlug: string
  installationId: string
}) {
  await onQueue(args.eventSlug, (database) =>
    database.runAsync(
      'DELETE FROM pending_attendance_scans WHERE event_slug = ? AND installation_id = ?',
      args.eventSlug,
      args.installationId,
    ),
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

// The Expo helper opens an unkeyed connection; this transaction keeps count and insert atomic.
async function inWriteTransaction<T>(
  database: SQLite.SQLiteDatabase,
  work: () => Promise<T>,
): Promise<T> {
  await database.execAsync('BEGIN IMMEDIATE')
  try {
    const result = await work()
    await database.execAsync('COMMIT')
    return result
  } catch (caught) {
    // A rollback that fails must not replace the error that caused it.
    await database.execAsync('ROLLBACK').catch(() => undefined)
    throw caught
  }
}

/** Rebuilds an unreadable queue once; a second failure is not file recovery. */
async function onQueue<T>(eventSlug: string, work: (database: SQLite.SQLiteDatabase) => Promise<T>) {
  try {
    return await runOnQueue(eventSlug, work)
  } catch (caught) {
    if (!unreadableStore(caught)) throw caught
    await resetEncryptedLocalDatabase(eventSlug)
    try {
      return await runOnQueue(eventSlug, work)
    } catch (retried) {
      if (!unreadableStore(retried)) throw retried
      throw new OperatorError(
        'This phone cannot save scans any more. Use another phone and tell a coordinator this one needs reinstalling.',
      )
    }
  }
}

function runOnQueue<T>(
  eventSlug: string,
  work: (database: SQLite.SQLiteDatabase) => Promise<T>,
) {
  return withEncryptedLocalDatabase(eventSlug, async (database) => {
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
    return work(database)
  })
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

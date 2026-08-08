import * as SQLite from 'expo-sqlite'
import { z } from 'zod'

import { encryptedLocalDatabase } from './encrypted-local-database'
const storedDraftSchema = z
  .object({
    version: z.literal(1),
    eventSlug: z.string(),
    scorecardId: z.string().min(1),
    serverDraftVersion: z.number().int().nonnegative(),
    ratings: z.array(
      z
        .object({
          criterionId: z.string().min(1),
          score: z.number().int().min(0).max(4),
          evidenceNote: z.string().optional(),
        })
        .strict(),
    ),
    privateNote: z.string(),
    savedAt: z.number().int().positive(),
  })
  .strict()

export type StoredScorecardDraft = z.infer<typeof storedDraftSchema>
type SaveDraftInput = Omit<StoredScorecardDraft, 'version' | 'savedAt'>

const scorecardDatabasePromises = new Map<string, Promise<SQLite.SQLiteDatabase>>()
const writeChains = new Map<string, Promise<void>>()

export async function checkEncryptedDraftStorage(eventSlug: string) {
  await scorecardDatabase(eventSlug)
}

export async function loadLocalScorecardDraft(eventSlug: string, scorecardId: string) {
  const database = await scorecardDatabase(eventSlug)
  const row: unknown = await database.getFirstAsync<unknown>(
    'SELECT payload FROM scorecard_drafts WHERE event_slug = ? AND scorecard_id = ?',
    eventSlug,
    scorecardId,
  )
  const decodedRow = z.object({ payload: z.string() }).safeParse(row)
  if (!decodedRow.success) return null
  const decoded: unknown = JSON.parse(decodedRow.data.payload)
  const parsed = storedDraftSchema.safeParse(decoded)
  if (!parsed.success || parsed.data.eventSlug !== eventSlug || parsed.data.scorecardId !== scorecardId) {
    throw new Error('The encrypted local scorecard draft is invalid.')
  }
  return parsed.data
}

export function saveLocalScorecardDraft(input: SaveDraftInput) {
  const draft: StoredScorecardDraft = {
    version: 1,
    ...input,
    savedAt: Date.now(),
  }
  return enqueue(input.eventSlug, input.scorecardId, async () => {
    const database = await scorecardDatabase(input.eventSlug)
    await database.runAsync(
      `INSERT INTO scorecard_drafts (event_slug, scorecard_id, payload, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(event_slug, scorecard_id)
       DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
      input.eventSlug,
      input.scorecardId,
      JSON.stringify(draft),
      draft.savedAt,
    )
  })
}

export function clearLocalScorecardDraft(eventSlug: string, scorecardId: string) {
  return enqueue(eventSlug, scorecardId, async () => {
    const database = await scorecardDatabase(eventSlug)
    await database.runAsync(
      'DELETE FROM scorecard_drafts WHERE event_slug = ? AND scorecard_id = ?',
      eventSlug,
      scorecardId,
    )
  })
}

function enqueue(eventSlug: string, scorecardId: string, operation: () => Promise<void>) {
  const key = `${eventSlug}:${scorecardId}`
  const prior = writeChains.get(key) ?? Promise.resolve()
  const next = prior.catch(() => undefined).then(operation)
  writeChains.set(key, next)
  void next
    .finally(() => {
      if (writeChains.get(key) === next) writeChains.delete(key)
    })
    .catch(() => undefined)
  return next
}

function scorecardDatabase(eventSlug: string) {
  const existing = scorecardDatabasePromises.get(eventSlug)
  if (existing) return existing
  const opening = initializeScorecardDatabase(eventSlug)
  scorecardDatabasePromises.set(eventSlug, opening)
  void opening.catch(() => {
    if (scorecardDatabasePromises.get(eventSlug) === opening) {
      scorecardDatabasePromises.delete(eventSlug)
    }
  })
  return opening
}

async function initializeScorecardDatabase(eventSlug: string) {
  const database = await encryptedLocalDatabase(eventSlug)
  await database.execAsync(`
    CREATE TABLE IF NOT EXISTS scorecard_drafts (
      event_slug TEXT NOT NULL,
      scorecard_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (event_slug, scorecard_id)
    );
  `)
  return database
}

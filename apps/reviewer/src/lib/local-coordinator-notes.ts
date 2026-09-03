import type { SQLiteDatabase } from "expo-sqlite";
import { z } from "zod";

import { withEncryptedLocalDatabase } from "./encrypted-local-database";

const storedCoordinatorNotesSchema = z
  .object({
    version: z.literal(1),
    eventSlug: z.string().min(1),
    reviewSessionId: z.string().min(1),
    serverNotesVersion: z.number().int().nonnegative(),
    findings: z.string(),
    commitments: z.string(),
    savedAt: z.number().int().positive(),
  })
  .strict();

export type StoredCoordinatorNotes = z.infer<typeof storedCoordinatorNotesSchema>;
type SaveCoordinatorNotesInput = Omit<StoredCoordinatorNotes, "version" | "savedAt">;

export function loadLocalCoordinatorNotes(eventSlug: string, reviewSessionId: string) {
  return withCoordinatorNotesDatabase(eventSlug, async (database) => {
    const row: unknown = await database.getFirstAsync<unknown>(
      "SELECT payload FROM coordinator_note_drafts WHERE event_slug = ? AND review_session_id = ?",
      eventSlug,
      reviewSessionId,
    );
    const decodedRow = z.object({ payload: z.string() }).safeParse(row);
    if (!decodedRow.success) return null;
    const decoded: unknown = JSON.parse(decodedRow.data.payload);
    const parsed = storedCoordinatorNotesSchema.safeParse(decoded);
    if (
      !parsed.success ||
      parsed.data.eventSlug !== eventSlug ||
      parsed.data.reviewSessionId !== reviewSessionId
    ) {
      throw new Error("The encrypted local panel notes are invalid.");
    }
    return parsed.data;
  });
}

export function saveLocalCoordinatorNotes(input: SaveCoordinatorNotesInput) {
  const draft: StoredCoordinatorNotes = {
    version: 1,
    ...input,
    savedAt: Date.now(),
  };
  return withCoordinatorNotesDatabase(input.eventSlug, async (database) => {
    await database.runAsync(
      `INSERT INTO coordinator_note_drafts (event_slug, review_session_id, payload, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(event_slug, review_session_id)
       DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
      input.eventSlug,
      input.reviewSessionId,
      JSON.stringify(draft),
      draft.savedAt,
    );
  });
}

export function clearLocalCoordinatorNotes(eventSlug: string, reviewSessionId: string) {
  return withCoordinatorNotesDatabase(eventSlug, async (database) => {
    await database.runAsync(
      "DELETE FROM coordinator_note_drafts WHERE event_slug = ? AND review_session_id = ?",
      eventSlug,
      reviewSessionId,
    );
  });
}

function withCoordinatorNotesDatabase<T>(
  eventSlug: string,
  work: (database: SQLiteDatabase) => Promise<T>,
) {
  return withEncryptedLocalDatabase(eventSlug, async (database) => {
    await database.execAsync(`
      CREATE TABLE IF NOT EXISTS coordinator_note_drafts (
        event_slug TEXT NOT NULL,
        review_session_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (event_slug, review_session_id)
      );
    `);
    return work(database);
  });
}

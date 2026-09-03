import { getRandomBytesAsync } from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import * as SQLite from "expo-sqlite";
import { z } from "zod";

const cipherVersionSchema = z.object({ cipher_version: z.string().min(1) }).loose();
const databasePromises = new Map<string, Promise<SQLite.SQLiteDatabase>>();
const databaseOperationTails = new Map<string, Promise<void>>();
const resetPromises = new Map<string, Promise<void>>();

/** True after recovery deletes unreadable local work during this launch. */
let storeWasReset = false;
const resetListeners = new Set<() => void>();

export function subscribeToLocalStoreReset(listener: () => void) {
  resetListeners.add(listener);
  return () => {
    resetListeners.delete(listener);
  };
}

export function localStoreWasReset() {
  return storeWasReset;
}

function recordStoreReset() {
  if (storeWasReset) return;
  storeWasReset = true;
  for (const listener of resetListeners) listener();
}

export function withEncryptedLocalDatabase<T>(
  eventSlug: string,
  operation: (database: SQLite.SQLiteDatabase) => Promise<T>,
): Promise<T> {
  validateEventSlug(eventSlug);
  return enqueueDatabaseOperation(eventSlug, async () =>
    operation(await encryptedLocalDatabase(eventSlug)),
  );
}

function encryptedLocalDatabase(eventSlug: string): Promise<SQLite.SQLiteDatabase> {
  const existing = databasePromises.get(eventSlug);
  if (existing) return existing;
  const opening = openEncryptedDatabase(eventSlug);
  databasePromises.set(eventSlug, opening);
  void opening.catch(() => {
    if (databasePromises.get(eventSlug) === opening) databasePromises.delete(eventSlug);
  });
  return opening;
}

async function openEncryptedDatabase(eventSlug: string) {
  const key = await databaseKey(eventSlug);
  const name = `c2c-reviewer-${eventSlug}.db`;
  try {
    return await openWithKey(name, key);
  } catch (caught) {
    // An unreadable encrypted store has no recoverable local data.
    if (!unreadableStore(caught)) throw caught;
    await SQLite.deleteDatabaseAsync(name);
    recordStoreReset();
    return await openWithKey(name, key);
  }
}

/** Closes and deletes the one shared local database for this event. */
export function resetEncryptedLocalDatabase(eventSlug: string) {
  validateEventSlug(eventSlug);
  const current = resetPromises.get(eventSlug);
  if (current) return current;
  const resetting = enqueueDatabaseOperation(eventSlug, () => performDatabaseReset(eventSlug)).finally(
    () => {
      if (resetPromises.get(eventSlug) === resetting) resetPromises.delete(eventSlug);
    },
  );
  resetPromises.set(eventSlug, resetting);
  return resetting;
}

async function performDatabaseReset(eventSlug: string) {
  const name = `c2c-reviewer-${eventSlug}.db`;
  const opened = databasePromises.get(eventSlug);
  databasePromises.delete(eventSlug);
  // Close the cached handle before deleting its file.
  if (opened) await opened.then((database) => database.closeAsync()).catch(() => undefined);
  await SQLite.deleteDatabaseAsync(name).catch(() => undefined);
  recordStoreReset();
}

function enqueueDatabaseOperation<T>(eventSlug: string, operation: () => Promise<T>) {
  const prior = databaseOperationTails.get(eventSlug) ?? Promise.resolve();
  const result = prior.catch(() => undefined).then(operation);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  databaseOperationTails.set(eventSlug, tail);
  void tail.then(() => {
    if (databaseOperationTails.get(eventSlug) === tail) {
      databaseOperationTails.delete(eventSlug);
    }
  });
  return result;
}

/** Detects wrong-key and corrupt-file errors through wrapped native causes. */
export function unreadableStore(caught: unknown) {
  for (let error: unknown = caught, depth = 0; error && depth < 5; depth += 1) {
    const message = error instanceof Error ? error.message : "Unknown local database error";
    if (
      message.includes("file is not a database") ||
      message.includes("SQLITE_NOTADB") ||
      /(?:^|[\s([,:=])code\s*[:=]?\s*26(?:$|[\s\]),;])/iu.test(message) ||
      structuredNotADatabaseCode(error)
    ) {
      return true;
    }
    error = errorCause(error);
  }
  return false;
}

function structuredNotADatabaseCode(error: unknown) {
  if (typeof error !== "object" || error === null) return false;
  if ("code" in error && isNotADatabaseCode(error.code)) return true;
  if ("sqliteCode" in error && isNotADatabaseCode(error.sqliteCode)) return true;
  if ("resultCode" in error && isNotADatabaseCode(error.resultCode)) return true;
  return false;
}

function isNotADatabaseCode(value: unknown) {
  return value === 26 || value === "26" || value === "SQLITE_NOTADB";
}

function errorCause(error: unknown): unknown {
  if (typeof error !== "object" || error === null || !("cause" in error)) return null;
  return error.cause;
}

async function openWithKey(name: string, key: string) {
  const database = await SQLite.openDatabaseAsync(name);
  try {
    await database.execAsync(`PRAGMA key = '${key}';`);
    const cipherVersion: unknown = await database.getFirstAsync<unknown>("PRAGMA cipher_version");
    if (!cipherVersionSchema.safeParse(cipherVersion).success) {
      throw new Error("Encrypted local storage requires the signed reviewer build.");
    }
    await database.execAsync("PRAGMA cipher_memory_security = ON;");
    // Force a page read because PRAGMA statements do not validate the key.
    await database.getFirstAsync("SELECT count(*) AS tables FROM sqlite_master");
    return database;
  } catch (caught) {
    // Close the handle so recovery can replace the file.
    await database.closeAsync().catch(() => undefined);
    throw caught;
  }
}

async function databaseKey(eventSlug: string) {
  const storageKey = `c2c.reviewer.local-key.${eventSlug}`;
  const stored = await SecureStore.getItemAsync(storageKey);
  if (stored) {
    if (!/^[a-f0-9]{64}$/u.test(stored)) {
      throw new Error("The encrypted local-storage key on this phone is invalid.");
    }
    return stored;
  }
  const key = bytesToHex(await getRandomBytesAsync(32));
  await SecureStore.setItemAsync(storageKey, key, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
  return key;
}

function validateEventSlug(eventSlug: string) {
  if (!/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/u.test(eventSlug)) {
    throw new Error("The event key cannot be used for encrypted local storage.");
  }
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

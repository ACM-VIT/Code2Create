import { getRandomBytesAsync } from 'expo-crypto'
import * as SecureStore from 'expo-secure-store'
import * as SQLite from 'expo-sqlite'
import { z } from 'zod'

const cipherVersionSchema = z.object({ cipher_version: z.string().min(1) }).passthrough()
const databasePromises = new Map<string, Promise<SQLite.SQLiteDatabase>>()

/**
 * Set once per launch when the store on this phone could not be opened and had
 * to be recreated. Anything queued but unsent went with it, and the person
 * holding the phone has to be told that rather than left to assume their scans
 * are still waiting to go.
 */
let storeWasReset = false
const resetListeners = new Set<() => void>()

/** Subscribable, because the store is opened lazily and long after first paint. */
export function subscribeToLocalStoreReset(listener: () => void) {
  resetListeners.add(listener)
  return () => {
    resetListeners.delete(listener)
  }
}

export function localStoreWasReset() {
  return storeWasReset
}

function recordStoreReset() {
  if (storeWasReset) return
  storeWasReset = true
  for (const listener of resetListeners) listener()
}

export function encryptedLocalDatabase(eventSlug: string) {
  validateEventSlug(eventSlug)
  const existing = databasePromises.get(eventSlug)
  if (existing) return existing
  const opening = openEncryptedDatabase(eventSlug)
  databasePromises.set(eventSlug, opening)
  void opening.catch(() => {
    if (databasePromises.get(eventSlug) === opening) databasePromises.delete(eventSlug)
  })
  return opening
}

async function openEncryptedDatabase(eventSlug: string) {
  const key = await databaseKey(eventSlug)
  const name = `c2c-reviewer-${eventSlug}.db`
  try {
    return await openWithKey(name, key)
  } catch (caught) {
    // A store the key will not open is a store nothing can read, so there is
    // no recovery to attempt and no data to salvage. Failing forever instead
    // leaves a phone at a door permanently unable to scan.
    if (!unreadableStore(caught)) throw caught
    await SQLite.deleteDatabaseAsync(name)
    recordStoreReset()
    return await openWithKey(name, key)
  }
}

/**
 * SQLite reports a wrong key and a corrupt file the same way: not a database.
 *
 * expo-sqlite wraps the native failure, so the useful text is on the cause
 * rather than the message. Reading only the message finds nothing and leaves a
 * phone stuck on an error it could have recovered from.
 */
function unreadableStore(caught: unknown) {
  for (let error: unknown = caught, depth = 0; error && depth < 5; depth += 1) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('file is not a database') || message.includes('code 26')) return true
    error = error instanceof Error ? error.cause : null
  }
  return false
}

async function openWithKey(name: string, key: string) {
  const database = await SQLite.openDatabaseAsync(name)
  try {
    await database.execAsync(`PRAGMA key = '${key}';`)
    const cipherVersion: unknown = await database.getFirstAsync<unknown>('PRAGMA cipher_version')
    if (!cipherVersionSchema.safeParse(cipherVersion).success) {
      throw new Error('Encrypted local storage requires the signed reviewer build.')
    }
    await database.execAsync('PRAGMA cipher_memory_security = ON;')
    // Pragmas never read a page, so a wrong key or a corrupt file opens happily
    // and only fails on the first real statement, deep inside whichever screen
    // asked for it. Reading the schema forces that failure into the one place
    // that can do something about it.
    await database.getFirstAsync('SELECT count(*) AS tables FROM sqlite_master')
    return database
  } catch (caught) {
    // The handle has to let go of the file before it can be replaced.
    await database.closeAsync().catch(() => undefined)
    throw caught
  }
}

async function databaseKey(eventSlug: string) {
  const storageKey = `c2c.reviewer.local-key.${eventSlug}`
  const stored = await SecureStore.getItemAsync(storageKey)
  if (stored) {
    if (!/^[a-f0-9]{64}$/u.test(stored)) {
      throw new Error('The encrypted local-storage key on this phone is invalid.')
    }
    return stored
  }
  const key = bytesToHex(await getRandomBytesAsync(32))
  await SecureStore.setItemAsync(storageKey, key, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  })
  return key
}

function validateEventSlug(eventSlug: string) {
  if (!/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/u.test(eventSlug)) {
    throw new Error('The event key cannot be used for encrypted local storage.')
  }
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

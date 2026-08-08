import { getRandomBytesAsync } from 'expo-crypto'
import * as SecureStore from 'expo-secure-store'
import * as SQLite from 'expo-sqlite'
import { z } from 'zod'

const cipherVersionSchema = z.object({ cipher_version: z.string().min(1) }).passthrough()
const databasePromises = new Map<string, Promise<SQLite.SQLiteDatabase>>()

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
  const database = await SQLite.openDatabaseAsync(`c2c-reviewer-${eventSlug}.db`)
  await database.execAsync(`PRAGMA key = '${key}';`)
  const cipherVersion: unknown = await database.getFirstAsync<unknown>('PRAGMA cipher_version')
  if (!cipherVersionSchema.safeParse(cipherVersion).success) {
    await database.closeAsync()
    throw new Error('Encrypted local storage requires the signed reviewer build.')
  }
  await database.execAsync('PRAGMA cipher_memory_security = ON;')
  return database
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

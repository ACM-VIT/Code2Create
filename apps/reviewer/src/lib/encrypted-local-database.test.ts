/* eslint-disable import/first -- native modules must be mocked before the module under test loads. */
import { beforeEach, describe, expect, test, vi } from 'vitest'

const secureStore = vi.hoisted(() => {
  const values = new Map<string, string>()
  return {
    values,
    getItemAsync: vi.fn(async (key: string) => values.get(key) ?? null),
    setItemAsync: vi.fn(async (key: string, value: string) => {
      values.set(key, value)
    }),
  }
})

const sqlite = vi.hoisted(() => {
  const first = createDatabase('first')
  const second = createDatabase('second')
  const databases = [first, second]
  return {
    first,
    second,
    databases,
    openDatabaseAsync: vi.fn(async () => {
      const database = databases.shift()
      if (!database) throw new Error('No test database remains.')
      return database
    }),
    deleteDatabaseAsync: vi.fn(async () => undefined),
  }

  function createDatabase(name: string) {
    return {
      name,
      execAsync: vi.fn(async () => undefined),
      getFirstAsync: vi.fn(async (statement: string) =>
        statement === 'PRAGMA cipher_version'
          ? { cipher_version: '4.7.2' }
          : { tables: 0 },
      ),
      closeAsync: vi.fn(async () => undefined),
    }
  }
})

vi.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked',
  getItemAsync: secureStore.getItemAsync,
  setItemAsync: secureStore.setItemAsync,
}))

vi.mock('expo-crypto', () => ({
  getRandomBytesAsync: vi.fn(async () => new Uint8Array(32).fill(7)),
}))

vi.mock('expo-sqlite', () => ({
  openDatabaseAsync: sqlite.openDatabaseAsync,
  deleteDatabaseAsync: sqlite.deleteDatabaseAsync,
}))

import {
  localStoreWasReset,
  resetEncryptedLocalDatabase,
  subscribeToLocalStoreReset,
  unreadableStore,
  withEncryptedLocalDatabase,
} from './encrypted-local-database'

describe('encrypted local database ownership', () => {
  beforeEach(() => {
    secureStore.values.clear()
    sqlite.openDatabaseAsync.mockClear()
    sqlite.deleteDatabaseAsync.mockClear()
  })

  test('serializes operations and rebuilds the store behind the same event lane', async () => {
    const listener = vi.fn()
    const unsubscribe = subscribeToLocalStoreReset(listener)
    const first = await withEncryptedLocalDatabase(
      'encrypted-reset-test',
      async (database) => database,
    )
    let releaseOperation: () => void = () => undefined
    const operationHeld = new Promise<void>((resolve) => {
      releaseOperation = resolve
    })
    const order: string[] = []
    const operation = withEncryptedLocalDatabase('encrypted-reset-test', async () => {
      order.push('operation-start')
      await operationHeld
      order.push('operation-end')
    })
    await vi.waitFor(() => expect(order).toEqual(['operation-start']))

    const queuedOperation = withEncryptedLocalDatabase('encrypted-reset-test', async () => {
      order.push('queued-operation')
    })
    await Promise.resolve()
    expect(order).toEqual(['operation-start'])
    releaseOperation()
    await Promise.all([operation, queuedOperation])
    expect(order).toEqual(['operation-start', 'operation-end', 'queued-operation'])

    let releaseClose: () => void = () => undefined
    const closeHeld = new Promise<undefined>((resolve) => {
      releaseClose = () => resolve(undefined)
    })
    sqlite.first.closeAsync.mockImplementationOnce(() => closeHeld)

    const resetting = resetEncryptedLocalDatabase('encrypted-reset-test')
    await vi.waitFor(() => expect(sqlite.first.closeAsync).toHaveBeenCalledOnce())
    const reopening = withEncryptedLocalDatabase(
      'encrypted-reset-test',
      async (database) => database,
    )

    expect(sqlite.openDatabaseAsync).toHaveBeenCalledTimes(1)
    releaseClose()
    await resetting
    const second = await reopening

    expect(first).not.toBe(second)
    expect(sqlite.deleteDatabaseAsync).toHaveBeenCalledWith(
      'c2c-reviewer-encrypted-reset-test.db',
    )
    expect(sqlite.openDatabaseAsync).toHaveBeenCalledTimes(2)
    expect(sqlite.deleteDatabaseAsync.mock.invocationCallOrder[0]).toBeLessThan(
      sqlite.openDatabaseAsync.mock.invocationCallOrder[1] ?? 0,
    )
    expect(localStoreWasReset()).toBe(true)
    expect(listener).toHaveBeenCalledOnce()
    unsubscribe()
  })

  test('classifies only the exact SQLite NOTADB result as destructive recovery', () => {
    expect(unreadableStore(new Error('sqlite failure (code 26): file unreadable'))).toBe(true)
    expect(unreadableStore({ sqliteCode: 26, cause: new Error('native failure') })).toBe(true)
    expect(unreadableStore(new Error('SQLITE_NOTADB while opening encrypted store'))).toBe(true)
    expect(unreadableStore(new Error('sqlite failure code 261 BUSY_RECOVERY'))).toBe(false)
    expect(unreadableStore({ sqliteCode: 261, cause: new Error('database is busy') })).toBe(false)
  })
})

import { Buffer } from 'node:buffer'

type StorageState = {
  cookies: readonly object[]
  origins: readonly object[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function decodeStorageState(encoded: string, label: string): StorageState {
  const value = encoded.trim()
  if (!value || !/^[a-zA-Z0-9+/=]+$/.test(value)) {
    throw new Error(`${label} storage state is not valid base64.`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64').toString('utf8'))
  } catch {
    throw new Error(`${label} storage state is not valid JSON.`)
  }
  if (
    !isRecord(parsed) ||
    !Array.isArray(parsed.cookies) ||
    !Array.isArray(parsed.origins) ||
    parsed.cookies.length === 0
  ) {
    throw new Error(`${label} storage state must contain at least one cookie and an origins array.`)
  }
  if (Object.keys(parsed).some((key) => key !== 'cookies' && key !== 'origins')) {
    throw new Error(`${label} storage state contains an unsupported top-level field.`)
  }
  if (!parsed.cookies.every(isRecord) || !parsed.origins.every(isRecord)) {
    throw new Error(`${label} storage state contains an invalid entry.`)
  }
  return { cookies: parsed.cookies, origins: parsed.origins }
}

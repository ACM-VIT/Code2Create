import { Buffer } from 'node:buffer'

export type EncryptionKeyConfiguration = {
  attendanceCurrentVersion: string
  attendancePreviousVersion: string | null
  providerCurrentVersion: string
  providerPreviousVersion: string | null
}

const versionPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const base64UrlPattern = /^[A-Za-z0-9_-]{43}$/

function requiredVersion(environment: NodeJS.ProcessEnv, name: string) {
  const value = environment[name]?.trim()
  if (!value || !versionPattern.test(value)) {
    throw new Error(`${name} must be a non-empty key version identifier.`)
  }
  return value
}

function requiredKey(environment: NodeJS.ProcessEnv, name: string) {
  const value = environment[name]?.trim()
  if (
    !value ||
    !base64UrlPattern.test(value) ||
    Buffer.from(value, 'base64url').length !== 32
  ) {
    throw new Error(`${name} must be one 32-byte base64url key without padding.`)
  }
  return Buffer.from(value, 'base64url')
}

function previousKeyPair(
  environment: NodeJS.ProcessEnv,
  versionName: string,
  keyName: string,
  currentVersion: string,
  currentKey: Buffer,
) {
  const hasVersion = Boolean(environment[versionName]?.trim())
  const hasKey = Boolean(environment[keyName]?.trim())
  if (!hasVersion && !hasKey) return null
  if (!hasVersion || !hasKey) {
    throw new Error(`${versionName} and ${keyName} must be configured together.`)
  }
  const version = requiredVersion(environment, versionName)
  const key = requiredKey(environment, keyName)
  if (version === currentVersion) {
    throw new Error(`${versionName} must differ from the current key version.`)
  }
  if (key.equals(currentKey)) {
    throw new Error(`${keyName} must differ from the current key material.`)
  }
  return version
}

export function readEncryptionKeyConfiguration(
  environment: NodeJS.ProcessEnv,
): EncryptionKeyConfiguration {
  const attendanceCurrentVersion = requiredVersion(
    environment,
    'ATTENDANCE_WRAPPING_KEY_VERSION',
  )
  const attendanceCurrentKey = requiredKey(environment, 'ATTENDANCE_WRAPPING_KEY')
  const providerCurrentVersion = requiredVersion(
    environment,
    'PROVIDER_TOKEN_ENCRYPTION_KEY_VERSION',
  )
  const providerCurrentKey = requiredKey(environment, 'PROVIDER_TOKEN_ENCRYPTION_KEY')
  return {
    attendanceCurrentVersion,
    attendancePreviousVersion: previousKeyPair(
      environment,
      'ATTENDANCE_PREVIOUS_WRAPPING_KEY_VERSION',
      'ATTENDANCE_PREVIOUS_WRAPPING_KEY',
      attendanceCurrentVersion,
      attendanceCurrentKey,
    ),
    providerCurrentVersion,
    providerPreviousVersion: previousKeyPair(
      environment,
      'PROVIDER_TOKEN_PREVIOUS_ENCRYPTION_KEY_VERSION',
      'PROVIDER_TOKEN_PREVIOUS_ENCRYPTION_KEY',
      providerCurrentVersion,
      providerCurrentKey,
    ),
  }
}

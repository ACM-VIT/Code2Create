import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import test from 'node:test'

import { readEncryptionKeyConfiguration } from './keyEnvironment.ts'

function key(fill: number) {
  return Buffer.alloc(32, fill).toString('base64url')
}

function validEnvironment(): NodeJS.ProcessEnv {
  return {
    ATTENDANCE_WRAPPING_KEY_VERSION: 'attendance-k2',
    ATTENDANCE_WRAPPING_KEY: key(1),
    ATTENDANCE_PREVIOUS_WRAPPING_KEY_VERSION: 'attendance-k1',
    ATTENDANCE_PREVIOUS_WRAPPING_KEY: key(2),
    PROVIDER_TOKEN_ENCRYPTION_KEY_VERSION: 'provider-k2',
    PROVIDER_TOKEN_ENCRYPTION_KEY: key(3),
    PROVIDER_TOKEN_PREVIOUS_ENCRYPTION_KEY_VERSION: 'provider-k1',
    PROVIDER_TOKEN_PREVIOUS_ENCRYPTION_KEY: key(4),
  }
}

test('release key configuration accepts one current and one previous key', () => {
  assert.deepEqual(readEncryptionKeyConfiguration(validEnvironment()), {
    attendanceCurrentVersion: 'attendance-k2',
    attendancePreviousVersion: 'attendance-k1',
    providerCurrentVersion: 'provider-k2',
    providerPreviousVersion: 'provider-k1',
  })
})

test('release key configuration allows no previous keys after rotation completes', () => {
  const environment = validEnvironment()
  delete environment.ATTENDANCE_PREVIOUS_WRAPPING_KEY_VERSION
  delete environment.ATTENDANCE_PREVIOUS_WRAPPING_KEY
  delete environment.PROVIDER_TOKEN_PREVIOUS_ENCRYPTION_KEY_VERSION
  delete environment.PROVIDER_TOKEN_PREVIOUS_ENCRYPTION_KEY
  assert.deepEqual(readEncryptionKeyConfiguration(environment), {
    attendanceCurrentVersion: 'attendance-k2',
    attendancePreviousVersion: null,
    providerCurrentVersion: 'provider-k2',
    providerPreviousVersion: null,
  })
})

test('release key configuration rejects malformed and incomplete rotation pairs', () => {
  const malformed = validEnvironment()
  malformed.ATTENDANCE_WRAPPING_KEY = 'short'
  assert.throws(() => readEncryptionKeyConfiguration(malformed), /32-byte base64url/)

  const incomplete = validEnvironment()
  delete incomplete.PROVIDER_TOKEN_PREVIOUS_ENCRYPTION_KEY
  assert.throws(() => readEncryptionKeyConfiguration(incomplete), /configured together/)

  const reusedVersion = validEnvironment()
  reusedVersion.PROVIDER_TOKEN_PREVIOUS_ENCRYPTION_KEY_VERSION = 'provider-k2'
  assert.throws(() => readEncryptionKeyConfiguration(reusedVersion), /must differ/)

  const reusedAttendanceMaterial = validEnvironment()
  reusedAttendanceMaterial.ATTENDANCE_PREVIOUS_WRAPPING_KEY =
    reusedAttendanceMaterial.ATTENDANCE_WRAPPING_KEY
  assert.throws(
    () => readEncryptionKeyConfiguration(reusedAttendanceMaterial),
    /current key material/,
  )

  const reusedProviderMaterial = validEnvironment()
  reusedProviderMaterial.PROVIDER_TOKEN_PREVIOUS_ENCRYPTION_KEY =
    reusedProviderMaterial.PROVIDER_TOKEN_ENCRYPTION_KEY
  assert.throws(
    () => readEncryptionKeyConfiguration(reusedProviderMaterial),
    /current key material/,
  )
})

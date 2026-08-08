import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import { decodeStorageState } from './storage-state.ts'

function requiredValue(name: string) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required.`)
  return value
}

async function writeState(encodedName: string, outputName: string, label: string) {
  const outputPath = resolve(requiredValue(outputName))
  const state = decodeStorageState(requiredValue(encodedName), label)
  await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 })
  await writeFile(outputPath, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600 })
  return outputPath
}

const [participantPath, operationsPath] = await Promise.all([
  writeState(
    'C2C_PARTICIPANT_STORAGE_STATE_BASE64',
    'C2C_PARTICIPANT_STORAGE_STATE_PATH',
    'Participant',
  ),
  writeState(
    'C2C_OPERATIONS_STORAGE_STATE_BASE64',
    'C2C_OPERATIONS_STORAGE_STATE_PATH',
    'Operations',
  ),
])

process.stdout.write(`Wrote protected browser states to ${participantPath} and ${operationsPath}.\n`)

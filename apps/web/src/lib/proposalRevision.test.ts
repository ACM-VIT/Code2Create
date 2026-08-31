import assert from 'node:assert/strict'
import test from 'node:test'

import {
  proposalRevisionBase,
  proposalRevisionBaseFingerprint,
} from './proposalRevision.ts'

test('operational application updates do not create proposal conflicts', () => {
  const project = { id: 'project-version-1', version: 1 }
  const beforeApplication = { contentVersion: 1, version: 4 }
  const afterApplication = { contentVersion: 1, version: 5 }
  const before = proposalRevisionBase(beforeApplication, project)
  const after = proposalRevisionBase(afterApplication, project)

  assert.equal(
    proposalRevisionBaseFingerprint(before),
    proposalRevisionBaseFingerprint(after),
  )
})

test('content and project changes still create proposal conflicts', () => {
  const initial = proposalRevisionBase(
    { contentVersion: 1 },
    { id: 'project-version-1', version: 1 },
  )
  const revisedContent = proposalRevisionBase(
    { contentVersion: 2 },
    { id: 'project-version-2', version: 2 },
  )

  assert.notEqual(
    proposalRevisionBaseFingerprint(initial),
    proposalRevisionBaseFingerprint(revisedContent),
  )
})

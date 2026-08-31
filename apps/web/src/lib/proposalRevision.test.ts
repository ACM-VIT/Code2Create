import assert from 'node:assert/strict'
import test from 'node:test'

import {
  proposalRevisionBase,
  proposalRevisionBaseFingerprint,
  recoverProposalRevision,
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

test('a pending answer revision survives navigation before autosave runs', () => {
  assert.deepEqual(
    recoverProposalRevision('Saved answer', 8, {
      base: '8',
      value: 'Pending answer revision',
    }),
    {
      answer: 'Pending answer revision',
      baseDraftVersion: 8,
      recovered: true,
    },
  )
})

test('a redundant or malformed revision draft does not replace the saved answer', () => {
  assert.deepEqual(
    recoverProposalRevision('Saved answer', 8, {
      base: 'not-a-version',
      value: 'Pending answer revision',
    }),
    {
      answer: 'Saved answer',
      baseDraftVersion: 8,
      recovered: false,
    },
  )
  assert.equal(
    recoverProposalRevision('Saved answer', 8, {
      base: '7',
      value: 'Saved answer',
    }).recovered,
    false,
  )
})

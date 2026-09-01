import assert from 'node:assert/strict'
import test from 'node:test'
import { ConvexError } from 'convex/values'

import {
  isIntakeCollaborationConflict,
  reconcileCommittedField,
  reconcileWorkingCopy,
  shouldRecoverFollowUpDraft,
} from './intakeCollaboration.ts'

const changedQuestion = {
  answer: 'A local answer that has not been saved.',
  currentMembershipId: 'membership-a',
  lastEditedByMembershipId: 'membership-b',
  nextQuestionId: 'question-2',
  priorQuestionId: 'question-1',
} as const

test('keeps a local answer when another member advances the question', () => {
  assert.equal(shouldRecoverFollowUpDraft(changedQuestion), true)
})

test('does not mislabel the current member save as a teammate change', () => {
  assert.equal(shouldRecoverFollowUpDraft({
    ...changedQuestion,
    lastEditedByMembershipId: changedQuestion.currentMembershipId,
  }), false)
})

test('does not recover a draft when the question did not change', () => {
  assert.equal(shouldRecoverFollowUpDraft({
    ...changedQuestion,
    nextQuestionId: changedQuestion.priorQuestionId,
  }), false)
})

test('does not create an empty recovered draft', () => {
  assert.equal(shouldRecoverFollowUpDraft({ ...changedQuestion, answer: '   ' }), false)
})

test('acknowledges a block deletion that reached the collaborative working copy', () => {
  assert.deepEqual(reconcileWorkingCopy({
    knownRevision: 2,
    localDirty: true,
    localValue: 'The shorter idea.',
    pendingValue: null,
    serverRevision: 3,
    serverValue: 'The shorter idea.',
  }), { kind: 'acknowledge', revision: 3 })
})

test('adopts a working-copy update when the local editor is idle', () => {
  assert.deepEqual(reconcileWorkingCopy({
    knownRevision: 1,
    localDirty: false,
    localValue: 'Confirmed idea',
    pendingValue: null,
    serverRevision: 2,
    serverValue: 'Updated working idea',
  }), {
    kind: 'adopt',
    revision: 2,
    value: 'Updated working idea',
  })
})

test('keeps a real concurrent working-copy edit as a conflict', () => {
  assert.deepEqual(reconcileWorkingCopy({
    knownRevision: 1,
    localDirty: true,
    localValue: 'My deletion',
    pendingValue: null,
    serverRevision: 2,
    serverValue: 'A teammate rewrite',
  }), { kind: 'conflict' })
})

test('keeps newer typing when the server echoes an earlier in-flight save', () => {
  assert.deepEqual(reconcileWorkingCopy({
    knownRevision: 1,
    localDirty: true,
    localValue: 'Newest local idea',
    pendingValue: 'Earlier autosave',
    serverRevision: 2,
    serverValue: 'Earlier autosave',
  }), { kind: 'continue', revision: 2 })
})

test('recognizes only trusted collaboration conflicts', () => {
  expectCollaborationConflict('DRAFT_CHANGED')
  expectCollaborationConflict('FOLLOW_UP_CHANGED')
  expectCollaborationConflict('WORKING_FIELD_CHANGED')
  assert.equal(
    isIntakeCollaborationConflict(
      new ConvexError({ code: 'NOT_A_CONFLICT', message: 'No.' }),
    ),
    false,
  )
  assert.equal(
    isIntakeCollaborationConflict({ data: { code: 'DRAFT_CHANGED' } }),
    false,
  )
})

function expectCollaborationConflict(code: string) {
  assert.equal(
    isIntakeCollaborationConflict(new ConvexError({ code, message: 'Conflict.' })),
    true,
  )
}

test('rebases an edit when only another proposal field changed', () => {
  assert.deepEqual(reconcileCommittedField({
    baseVersion: 4,
    baseValue: 'Same answer',
    localValue: 'My pending answer',
    serverVersion: 5,
    serverValue: 'Same answer',
  }), { kind: 'rebase', version: 5 })
})

test('acknowledges the same value saved by another session', () => {
  assert.deepEqual(reconcileCommittedField({
    baseVersion: 4,
    baseValue: 'Old answer',
    localValue: 'Shared answer',
    serverVersion: 5,
    serverValue: 'Shared answer',
  }), { kind: 'acknowledge', version: 5 })
})

test('requires a choice only when the same committed field diverged', () => {
  assert.deepEqual(reconcileCommittedField({
    baseVersion: 4,
    baseValue: 'Old answer',
    localValue: 'My answer',
    serverVersion: 5,
    serverValue: 'Their answer',
  }), { kind: 'conflict' })
})

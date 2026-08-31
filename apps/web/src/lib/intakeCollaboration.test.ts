import assert from 'node:assert/strict'
import test from 'node:test'

import { shouldRecoverFollowUpDraft } from './intakeCollaboration.ts'

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

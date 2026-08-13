import { describe, expect, test } from 'vitest'

import { reviewWorkspaceKey } from './review-workspace-key'

describe('review workspace identity', () => {
  test('changes when the owning review or scorecard changes', () => {
    const first = reviewWorkspaceKey({ id: 'review-a', scorecard: { id: 'scorecard-a' } })
    const nextReview = reviewWorkspaceKey({ id: 'review-b', scorecard: { id: 'scorecard-b' } })
    const replacementScorecard = reviewWorkspaceKey({
      id: 'review-a',
      scorecard: { id: 'scorecard-c' },
    })

    expect(nextReview).not.toBe(first)
    expect(replacementScorecard).not.toBe(first)
  })
})

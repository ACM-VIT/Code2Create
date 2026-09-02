let pendingCelebration = false

/**
 * The one-shot handoff between the submit button and the Submitted screen:
 * submitting marks the flag, and the next Submitted mount consumes it to
 * play the bloom celebration exactly once. This deliberately stays in memory:
 * a page reload is a new visit and must not replay the submission animation.
 */
export function markSubmissionCelebration() {
  pendingCelebration = true
}

export function clearSubmissionCelebration() {
  pendingCelebration = false
}

export function consumeSubmissionCelebration(): boolean {
  const shouldCelebrate = pendingCelebration
  pendingCelebration = false
  return shouldCelebrate
}

const storageKey = 'c2c:celebrate-submission'

/**
 * The one-shot handoff between the submit button and the Submitted screen:
 * submitting marks the flag, and the next Submitted mount consumes it to
 * play the bloom celebration exactly once. Session storage, so a refresh
 * or a returning visit stays quiet.
 */
export function markSubmissionCelebration() {
  try {
    sessionStorage.setItem(storageKey, '1')
  } catch {
    // A private window without storage just skips the celebration.
  }
}

export function clearSubmissionCelebration() {
  try {
    sessionStorage.removeItem(storageKey)
  } catch {
    // Storage failures already make the celebration unavailable.
  }
}

export function consumeSubmissionCelebration(): boolean {
  try {
    if (sessionStorage.getItem(storageKey) === null) return false
    sessionStorage.removeItem(storageKey)
    return true
  } catch {
    return false
  }
}

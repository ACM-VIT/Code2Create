const seenKey = 'code2create.sglang-note-seen'

/** Whether this browser has already been shown the one-time SGLang note. */
export function sglangInterludeSeen(): boolean {
  try {
    return localStorage.getItem(seenKey) === 'true'
  } catch {
    return true
  }
}

export function markSglangInterludeSeen() {
  try {
    localStorage.setItem(seenKey, 'true')
  } catch {
    // Nothing to do — the note simply shows again next time.
  }
}

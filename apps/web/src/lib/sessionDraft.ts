export function readSessionDraft(key: string) {
  try {
    return window.sessionStorage.getItem(key)
  } catch {
    return null
  }
}

export function writeSessionDraft(key: string, value: string) {
  try {
    window.sessionStorage.setItem(key, value)
  } catch {
    // A private browser session can reject storage. The live editor still works.
  }
}

export function clearSessionDraft(key: string) {
  try {
    window.sessionStorage.removeItem(key)
  } catch {
    // A private browser session can reject storage. There is nothing else to clear.
  }
}

export type VersionedSessionDraft = {
  base: string;
  value: string;
};

export function parseVersionedSessionDraft(stored: string | null): VersionedSessionDraft | null {
  if (stored === null) return null;
  const values = new URLSearchParams(stored);
  const base = values.get("base");
  const value = values.get("value");
  if (values.get("version") !== "1" || base === null || value === null) return null;
  return { base, value };
}

export function serializeVersionedSessionDraft(draft: VersionedSessionDraft) {
  const values = new URLSearchParams();
  values.set("version", "1");
  values.set("base", draft.base);
  values.set("value", draft.value);
  return values.toString();
}

export function sessionDraftConflicts(draft: VersionedSessionDraft | null, currentBase: string) {
  return draft !== null && draft.base !== currentBase;
}

export function readVersionedSessionDraft(key: string) {
  try {
    return parseVersionedSessionDraft(window.sessionStorage.getItem(key));
  } catch {
    return null;
  }
}

export function writeVersionedSessionDraft(key: string, draft: VersionedSessionDraft) {
  try {
    window.sessionStorage.setItem(key, serializeVersionedSessionDraft(draft));
  } catch {
    // A private browser session can reject storage. The live editor still works.
  }
}

export function clearSessionDraft(key: string) {
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // A private browser session can reject storage. There is nothing else to clear.
  }
}

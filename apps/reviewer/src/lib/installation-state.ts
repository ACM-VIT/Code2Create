const revisions = new Map<string, number>();
const listeners = new Map<string, Set<() => void>>();

export function installationRevision(eventSlug: string) {
  return revisions.get(eventSlug) ?? 0;
}

export function subscribeToInstallationChanges(eventSlug: string, listener: () => void) {
  const eventListeners = listeners.get(eventSlug) ?? new Set<() => void>();
  eventListeners.add(listener);
  listeners.set(eventSlug, eventListeners);
  return () => {
    eventListeners.delete(listener);
    if (eventListeners.size === 0) listeners.delete(eventSlug);
  };
}

export function notifyInstallationChanged(eventSlug: string) {
  revisions.set(eventSlug, installationRevision(eventSlug) + 1);
  for (const listener of listeners.get(eventSlug) ?? []) listener();
}

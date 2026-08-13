import { describe, expect, test, vi } from 'vitest'

import {
  installationRevision,
  notifyInstallationChanged,
  subscribeToInstallationChanges,
} from './installation-state'

describe('installation state', () => {
  test('notifies an already-mounted root subscriber when setup saves a device', () => {
    const eventSlug = `setup-${crypto.randomUUID()}`
    const listener = vi.fn()
    const unsubscribe = subscribeToInstallationChanges(eventSlug, listener)

    expect(installationRevision(eventSlug)).toBe(0)
    notifyInstallationChanged(eventSlug)

    expect(installationRevision(eventSlug)).toBe(1)
    expect(listener).toHaveBeenCalledOnce()

    unsubscribe()
    notifyInstallationChanged(eventSlug)
    expect(listener).toHaveBeenCalledOnce()
  })
})

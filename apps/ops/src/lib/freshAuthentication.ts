import { useSyncExternalStore } from 'react'

export type FreshAuthenticationRequest = {
  id: string
}

type ActiveFreshAuthentication = {
  request: FreshAuthenticationRequest
  complete: () => void
  cancel: (reason: FreshAuthenticationCancelledError) => void
}

const listeners = new Set<() => void>()
let active: ActiveFreshAuthentication | null = null
let activePromise: Promise<void> | null = null

export class FreshAuthenticationCancelledError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FreshAuthenticationCancelledError'
  }
}

export function requestFreshAuthentication() {
  if (activePromise) return activePromise

  const request = { id: crypto.randomUUID() }
  const promise = new Promise<void>((resolve, reject) => {
    active = {
      request,
      complete: resolve,
      cancel: reject,
    }
  })
  activePromise = promise
  changed()
  return promise
}

export function completeFreshAuthentication(requestId: string) {
  if (!active || active.request.id !== requestId) return false
  const complete = active.complete
  active = null
  activePromise = null
  changed()
  complete()
  return true
}

export function cancelFreshAuthentication(requestId: string) {
  if (!active || active.request.id !== requestId) return false
  const cancel = active.cancel
  active = null
  activePromise = null
  changed()
  cancel(new FreshAuthenticationCancelledError('Google verification was cancelled.'))
  return true
}

export function currentFreshAuthenticationRequest() {
  return active?.request ?? null
}

export function useFreshAuthenticationRequest() {
  useSyncExternalStore(subscribe, currentFreshAuthenticationRequest, currentFreshAuthenticationRequest)
  return currentFreshAuthenticationRequest()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function changed() {
  for (const listener of listeners) listener()
}

/// <reference types="google.accounts" />

import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'

import { googleButtonConfiguration, googleFedCmConfiguration } from './google-fedcm-config'
import type { Code2CreateAuthClient } from './index'

declare global {
  interface Navigator {
    brave?: {
      isBrave: () => Promise<boolean>
    }
  }

  interface Window {
    IdentityCredential?: object
  }
}

type ButtonPhase = 'loading' | 'ready' | 'signing-in' | 'unavailable'
type ButtonLayer = 0 | 1

const googleIdentityScriptUrl = 'https://accounts.google.com/gsi/client'
let googleIdentityScript: Promise<void> | null = null

export function GoogleFedCmButton({
  authClient,
  clientId,
  hostedDomain,
  appearance = 'dark',
  loading,
  pending,
  fallback,
  onError,
}: {
  authClient: Code2CreateAuthClient
  clientId: string
  hostedDomain?: string
  /** Matches Google's button to the surrounding page theme. */
  appearance?: 'light' | 'dark'
  loading: ReactNode
  pending: ReactNode
  fallback: ReactNode
  onError: (message: string) => void
}) {
  const firstContainer = useRef<HTMLDivElement>(null)
  const secondContainer = useRef<HTMLDivElement>(null)
  const activeLayerRef = useRef<ButtonLayer | null>(null)
  const errorHandler = useRef(onError)
  const signInPending = useRef(false)
  const [activeLayer, setActiveLayer] = useState<ButtonLayer | null>(null)
  const [replacing, setReplacing] = useState(false)
  const [phase, setPhase] = useState<ButtonPhase>('loading')

  useEffect(() => {
    errorHandler.current = onError
  }, [onError])

  useEffect(() => {
    const nextLayer: ButtonLayer = activeLayerRef.current === 0 ? 1 : 0
    const element = nextLayer === 0 ? firstContainer.current : secondContainer.current
    if (!element) return
    const hasActiveButton = activeLayerRef.current !== null
    let active = true
    if (hasActiveButton) setReplacing(true)

    const receiveCredential = async (response: google.accounts.id.CredentialResponse) => {
      if (!active || signInPending.current) return
      signInPending.current = true
      setPhase('signing-in')
      try {
        const result = await authClient.$fetch('/one-tap/callback', {
          method: 'POST',
          body: {
            idToken: response.credential,
          },
          throw: false,
        })
        if (!active) return
        if (result.error) {
          signInPending.current = false
          setPhase('ready')
          errorHandler.current('Google could not complete sign-in. Try again or use another account.')
          return
        }
        authClient.updateSession()
      } catch {
        if (!active) return
        signInPending.current = false
        setPhase('ready')
        errorHandler.current('Google could not complete sign-in. Try again or use another account.')
      }
    }

    void (async () => {
      try {
        const [, useFedCm] = await Promise.all([
          loadGoogleIdentityServices(),
          supportsGoogleFedCmButton(),
        ])
        if (!active) return

        google.accounts.id.initialize(
          googleFedCmConfiguration({
            clientId,
            ...(hostedDomain ? { hostedDomain } : {}),
            onCredential: (response) => void receiveCredential(response),
            useFedCm,
          }),
        )
        element.replaceChildren()
        const buttonWidth = element.parentElement?.getBoundingClientRect().width
          ?? element.getBoundingClientRect().width
        google.accounts.id.renderButton(
          element,
          googleButtonConfiguration(buttonWidth, appearance),
        )
        const ready = await waitForRenderedGoogleButton(element, () => active)
        if (!active) return
        if (!ready) throw new Error('Google button did not finish rendering.')

        activeLayerRef.current = nextLayer
        setActiveLayer(nextLayer)
        setReplacing(false)
        setPhase('ready')
      } catch {
        if (!active) return
        setReplacing(false)
        setPhase('unavailable')
      }
    })()

    return () => {
      active = false
    }
  }, [appearance, authClient, clientId, hostedDomain])

  const googleLayer = (
    layer: ButtonLayer,
    ref: RefObject<HTMLDivElement | null>,
  ) => {
    const visible = phase === 'ready' && activeLayer === layer
    return (
      <div
        ref={ref}
        aria-hidden={!visible}
        style={{
          gridArea: '1 / 1',
          opacity: visible ? 1 : 0,
          pointerEvents: visible && !replacing ? 'auto' : 'none',
          minHeight: 44,
          width: '100%',
        }}
      />
    )
  }

  return (
    <div
      style={{
        display: 'grid',
        width: '100%',
        maxWidth: 320,
        height: 55,
        marginInline: 'auto',
        alignItems: 'center',
        overflow: 'hidden',
      }}
    >
      {googleLayer(0, firstContainer)}
      {googleLayer(1, secondContainer)}
      {phase === 'loading' ? <div style={{ gridArea: '1 / 1' }}>{loading}</div> : null}
      {phase === 'signing-in' ? <div style={{ gridArea: '1 / 1' }}>{pending}</div> : null}
      {phase === 'unavailable' ? <div style={{ gridArea: '1 / 1' }}>{fallback}</div> : null}
    </div>
  )
}

function waitForRenderedGoogleButton(
  element: HTMLDivElement,
  isActive: () => boolean,
) {
  const startedAt = performance.now()
  return new Promise<boolean>((resolve) => {
    const check = () => {
      if (!isActive()) {
        resolve(false)
        return
      }
      const iframe = Array.from(element.querySelectorAll('iframe')).find(
        (candidate) => candidate.title === 'Sign in with Google Button',
      )
      const bounds = iframe?.getBoundingClientRect()
      if (bounds && bounds.width > 0 && bounds.height > 0) {
        resolve(true)
        return
      }
      if (performance.now() - startedAt >= 8_000) {
        resolve(false)
        return
      }
      window.requestAnimationFrame(check)
    }
    window.requestAnimationFrame(check)
  })
}

async function supportsGoogleFedCmButton() {
  if (typeof window.IdentityCredential === 'undefined') return false
  if (!navigator.brave) return true

  try {
    return !(await navigator.brave.isBrave())
  } catch {
    return false
  }
}

function loadGoogleIdentityServices() {
  if (typeof google !== 'undefined' && google.accounts?.id) return Promise.resolve()
  if (googleIdentityScript) return googleIdentityScript

  googleIdentityScript = new Promise((resolve, reject) => {
    const script = document.createElement('script')
    const timeout = window.setTimeout(() => reject(new Error('Google Identity Services timed out.')), 8_000)
    script.src = googleIdentityScriptUrl
    script.async = true
    script.defer = true
    script.onload = () => {
      window.clearTimeout(timeout)
      if (typeof google === 'undefined' || !google.accounts?.id) {
        reject(new Error('Google Identity Services did not initialize.'))
        return
      }
      resolve()
    }
    script.onerror = () => {
      window.clearTimeout(timeout)
      reject(new Error('Google Identity Services could not be loaded.'))
    }
    document.head.appendChild(script)
  })
  void googleIdentityScript.catch(() => {
    googleIdentityScript = null
  })
  return googleIdentityScript
}

/// <reference types="google.accounts" />

import { useEffect, useRef, useState, type ReactNode } from 'react'

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

const googleIdentityScriptUrl = 'https://accounts.google.com/gsi/client'
let googleIdentityScript: Promise<void> | null = null

export function GoogleFedCmButton({
  authClient,
  clientId,
  hostedDomain,
  loading,
  pending,
  fallback,
  onError,
}: {
  authClient: Code2CreateAuthClient
  clientId: string
  hostedDomain?: string
  loading: ReactNode
  pending: ReactNode
  fallback: ReactNode
  onError: (message: string) => void
}) {
  const container = useRef<HTMLDivElement>(null)
  const errorHandler = useRef(onError)
  const signInPending = useRef(false)
  const [phase, setPhase] = useState<ButtonPhase>('loading')

  useEffect(() => {
    errorHandler.current = onError
  }, [onError])

  useEffect(() => {
    const element = container.current
    if (!element) return
    let active = true

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

    void Promise.all([loadGoogleIdentityServices(), supportsGoogleFedCmButton()]).then(
      ([, useFedCm]) => {
        if (!active) return
        try {
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
            googleButtonConfiguration(buttonWidth),
          )
          setPhase('ready')
        } catch {
          setPhase('unavailable')
        }
      },
      () => {
        if (!active) return
        setPhase('unavailable')
      },
    )

    return () => {
      active = false
    }
  }, [authClient, clientId, hostedDomain])

  return (
    <div
      style={{
        display: 'grid',
        width: '100%',
        maxWidth: 320,
        minHeight: 55,
        marginInline: 'auto',
        alignItems: 'center',
        overflow: 'hidden',
      }}
    >
      <div
        ref={container}
        aria-hidden={phase !== 'ready'}
        style={{
          gridArea: '1 / 1',
          visibility: phase === 'ready' ? 'visible' : 'hidden',
          pointerEvents: phase === 'ready' ? 'auto' : 'none',
          minHeight: 44,
          width: '100%',
        }}
      />
      {phase === 'loading' ? <div style={{ gridArea: '1 / 1' }}>{loading}</div> : null}
      {phase === 'signing-in' ? <div style={{ gridArea: '1 / 1' }}>{pending}</div> : null}
      {phase === 'unavailable' ? <div style={{ gridArea: '1 / 1' }}>{fallback}</div> : null}
    </div>
  )
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

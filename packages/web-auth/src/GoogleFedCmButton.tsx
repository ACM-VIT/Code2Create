/// <reference types="google.accounts" />

import { useEffect, useRef, useState, type ReactNode } from 'react'

import { googleButtonConfiguration, googleFedCmConfiguration } from './google-fedcm-config'
import type { Code2CreateAuthClient } from './index'

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

    void loadGoogleIdentityServices().then(
      () => {
        if (!active) return
        try {
          google.accounts.id.initialize(
            googleFedCmConfiguration({
              clientId,
              ...(hostedDomain ? { hostedDomain } : {}),
              onCredential: (response) => void receiveCredential(response),
            }),
          )
          element.replaceChildren()
          google.accounts.id.renderButton(
            element,
            googleButtonConfiguration(element.getBoundingClientRect().width),
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
      element.replaceChildren()
    }
  }, [authClient, clientId, hostedDomain])

  return (
    <div style={{ display: 'grid', width: '100%' }}>
      <div
        ref={container}
        aria-hidden={phase !== 'ready'}
        style={{
          display: phase === 'ready' ? 'block' : 'none',
          minHeight: 44,
          width: '100%',
          maxWidth: 320,
          marginInline: 'auto',
        }}
      />
      {phase === 'loading' ? loading : null}
      {phase === 'signing-in' ? pending : null}
      {phase === 'unavailable' ? fallback : null}
    </div>
  )
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

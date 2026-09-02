import { PostHogErrorBoundary, PostHogProvider, usePostHog } from '@posthog/react'
import {
  Component,
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ErrorInfo,
  type ReactNode,
} from 'react'

import {
  parseDeploymentEnvironment,
  requiredTelemetryRelease,
  validatePostHogHost,
} from './environment.ts'
import { scrubPostHogEvent } from './privacy.ts'
import { isChunkLoadFailure } from './browserRecovery.ts'

export { installBrowserChunkRecovery } from './browserRecovery.ts'

export type BrowserSurface = 'landing-web' | 'participant-web' | 'operations-web'

export type BrowserObservabilityConfiguration = {
  projectToken: string | undefined
  host: string | undefined
  deploymentEnvironment: string | undefined
  release: string | undefined
  surface: BrowserSurface
  development: boolean
}

const ObservabilityContext = createContext(false)
const missingConfigurationMessage =
  'PostHog is not configured. Set the project token and host in your environment variables.'

export function ClientObservabilityProvider({
  children,
  configuration,
}: {
  children: ReactNode
  configuration: BrowserObservabilityConfiguration
}) {
  const projectToken = configuration.projectToken?.trim()
  const host = configuration.host?.trim()
  useEffect(() => {
    if ((!projectToken || !host) && configuration.development) {
      console.error(new Error(`${configuration.surface}: ${missingConfigurationMessage}`))
    }
  }, [configuration.development, configuration.surface, host, projectToken])

  if (!projectToken || !host) {
    return (
      <>
        <LocalErrorBoundary>{children}</LocalErrorBoundary>
      </>
    )
  }

  const deploymentEnvironment = parseDeploymentEnvironment(configuration.deploymentEnvironment)
  const release = requiredTelemetryRelease(configuration.release, 'VITE_RELEASE_ID')
  const apiHost = validatePostHogHost(host)
  const commonProperties = {
    c2c_environment: deploymentEnvironment,
    c2c_release: release,
    c2c_surface: configuration.surface,
  }

  return (
    <ObservabilityContext.Provider value>
      <PostHogProvider
        apiKey={projectToken}
        options={{
          api_host: apiHost,
          defaults: '2026-05-30',
          autocapture: false,
          capture_pageview: 'history_change',
          capture_pageleave: true,
          capture_exceptions: true,
          capture_heatmaps: false,
          capture_performance: false,
          disable_capture_url_hashes: true,
          disable_session_recording: true,
          mask_all_element_attributes: true,
          mask_all_text: true,
          person_profiles: 'identified_only',
          before_send: scrubPostHogEvent,
          loaded: (posthog) => posthog.register(commonProperties),
        }}
      >
        <PostHogErrorBoundary
          additionalProperties={commonProperties}
          fallback={ErrorFallback}
        >
          {children}
        </PostHogErrorBoundary>
      </PostHogProvider>
    </ObservabilityContext.Provider>
  )
}

export function ClientObservabilityIdentity({ distinctId }: { distinctId: string | null }) {
  const enabled = useContext(ObservabilityContext)
  return enabled ? <EnabledIdentity distinctId={distinctId} /> : null
}

function EnabledIdentity({ distinctId }: { distinctId: string | null }) {
  const posthog = usePostHog()
  const previousDistinctId = useRef<string | null>(null)
  useEffect(() => {
    if (distinctId) {
      posthog.identify(distinctId)
      previousDistinctId.current = distinctId
      return
    }
    if (previousDistinctId.current) {
      posthog.reset()
      previousDistinctId.current = null
    }
  }, [distinctId, posthog])
  return null
}

class LocalErrorBoundary extends Component<
  { children: ReactNode },
  { error: unknown; failed: boolean }
> {
  override state = { error: null, failed: false }

  static getDerivedStateFromError(error: unknown) {
    return { error, failed: true }
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error(error, errorInfo.componentStack)
  }

  override render() {
    return this.state.failed ? <ErrorFallback error={this.state.error} /> : this.props.children
  }
}

function ErrorFallback({ error }: { error: unknown }) {
  const online = useOnlineStatus()
  const chunkFailure = isChunkLoadFailure(error)

  useEffect(() => {
    if (!chunkFailure || online) return
    const reload = () => window.location.reload()
    window.addEventListener('online', reload, { once: true })
    return () => window.removeEventListener('online', reload)
  }, [chunkFailure, online])

  const title = chunkFailure
    ? online
      ? 'This screen didn’t finish loading.'
      : 'The connection dropped while this screen was loading.'
    : 'This screen hit an unexpected problem.'
  const explanation = chunkFailure
    ? online
      ? 'The connection is back. Try loading the screen again.'
      : 'Keep this page open. It will try again automatically when this device reconnects.'
    : 'Reload once. If it happens again, tell event support what you were trying to open.'

  return (
    <main style={{ background: '#0a0a09', color: '#f0eee8', minHeight: '100vh', padding: '15vh 24px' }}>
      <section style={{ margin: '0 auto', maxWidth: 520 }} role="alert">
        <p style={{ color: '#9b9992', margin: '0 0 12px' }}>Code2Create</p>
        <h1 style={{ fontSize: 28, fontWeight: 500, margin: '0 0 12px' }}>{title}</h1>
        <p style={{ color: '#b9b7b0', lineHeight: 1.6 }}>{explanation}</p>
        <button
          type="button"
          disabled={!online}
          onClick={() => window.location.reload()}
          style={{ cursor: online ? 'pointer' : 'wait', marginTop: 16 }}
        >
          {online ? 'Try again' : 'Waiting for connection…'}
        </button>
      </section>
    </main>
  )
}

function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine,
  )

  useEffect(() => {
    const markOnline = () => setOnline(true)
    const markOffline = () => setOnline(false)
    window.addEventListener('online', markOnline)
    window.addEventListener('offline', markOffline)
    return () => {
      window.removeEventListener('online', markOnline)
      window.removeEventListener('offline', markOffline)
    }
  }, [])

  return online
}

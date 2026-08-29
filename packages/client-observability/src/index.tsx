import { PostHogErrorBoundary, PostHogProvider, usePostHog } from '@posthog/react'
import {
  Component,
  createContext,
  useContext,
  useEffect,
  useRef,
  type ErrorInfo,
  type ReactNode,
} from 'react'

import {
  parseDeploymentEnvironment,
  requiredTelemetryRelease,
  validatePostHogHost,
} from './environment.ts'
import { scrubPostHogEvent } from './privacy.ts'

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
    return <LocalErrorBoundary>{children}</LocalErrorBoundary>
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
          fallback={<ErrorFallback />}
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

class LocalErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error(error, errorInfo.componentStack)
  }

  override render() {
    return this.state.failed ? <ErrorFallback /> : this.props.children
  }
}

function ErrorFallback() {
  return (
    <main style={{ background: '#0a0a09', color: '#f0eee8', minHeight: '100vh', padding: '15vh 24px' }}>
      <section style={{ margin: '0 auto', maxWidth: 520 }} role="alert">
        <p style={{ color: '#9b9992', margin: '0 0 12px' }}>Code2Create</p>
        <h1 style={{ fontSize: 28, fontWeight: 500, margin: '0 0 12px' }}>This screen stopped unexpectedly.</h1>
        <p style={{ color: '#b9b7b0', lineHeight: 1.6 }}>Reload once. If it happens again, tell event support what you were trying to open.</p>
        <button type="button" onClick={() => window.location.reload()} style={{ marginTop: 16 }}>Reload</button>
      </section>
    </main>
  )
}

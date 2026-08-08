import * as Sentry from '@sentry/react'
import type { ReactNode } from 'react'

import {
  parseDeploymentEnvironment,
  requiredTelemetryRelease,
  validateTelemetryDsn,
} from './environment.ts'
import { scrubTelemetryBreadcrumb, scrubTelemetryEvent } from './privacy.ts'

export type BrowserSurface = 'participant-web' | 'operations-web'

type BrowserObservabilityConfiguration = {
  dsn: string | undefined
  environment: string | undefined
  release: string | undefined
  surface: BrowserSurface
}

let initialized = false

export function initializeBrowserObservability(configuration: BrowserObservabilityConfiguration) {
  const dsn = configuration.dsn?.trim()
  if (!dsn) return false
  if (initialized) return true

  const environment = parseDeploymentEnvironment(configuration.environment)
  const release = requiredTelemetryRelease(configuration.release, 'VITE_RELEASE_ID')
  validateTelemetryDsn(dsn)
  Sentry.init({
    dsn,
    environment,
    release,
    sendDefaultPii: false,
    attachStacktrace: true,
    maxBreadcrumbs: 40,
    initialScope: { tags: { surface: configuration.surface } },
    beforeSend(event) {
      scrubTelemetryEvent(event)
      return event
    },
    beforeBreadcrumb(breadcrumb) {
      return scrubTelemetryBreadcrumb(breadcrumb)
    },
  })
  initialized = true
  return true
}

export function ClientErrorBoundary({ children }: { children: ReactNode }) {
  return (
    <Sentry.ErrorBoundary
      fallback={(
        <main style={{ background: '#0a0a09', color: '#f0eee8', minHeight: '100vh', padding: '15vh 24px' }}>
          <section style={{ margin: '0 auto', maxWidth: 520 }} role="alert">
            <p style={{ color: '#9b9992', margin: '0 0 12px' }}>Code2Create</p>
            <h1 style={{ fontSize: 28, fontWeight: 500, margin: '0 0 12px' }}>This screen stopped unexpectedly.</h1>
            <p style={{ color: '#b9b7b0', lineHeight: 1.6 }}>Reload once. If it happens again, tell event support what you were trying to open.</p>
            <button type="button" onClick={() => window.location.reload()} style={{ marginTop: 16 }}>Reload</button>
          </section>
        </main>
      )}
    >
      {children}
    </Sentry.ErrorBoundary>
  )
}

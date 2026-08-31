import { ConvexReactClient } from 'convex/react'
import {
  ClientObservabilityProvider,
  installBrowserChunkRecovery,
} from '@code2create/client-observability'
import { Code2CreateAuthProvider, createCode2CreateAuthClient } from '@code2create/web-auth'
import { StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import './index.css'
import App from './App.tsx'
import { clientConfiguration } from './lib/config.ts'
import { initPortalTheme } from './lib/portalTheme.ts'

installBrowserChunkRecovery()
initPortalTheme()

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('The application root element is missing.')
const root = createRoot(rootElement)

if (!clientConfiguration.convexUrl || !clientConfiguration.convexSiteUrl) {
  render(
    <main className="centered-shell">
      <section className="narrow-panel">
        <p className="eyebrow">Code2Create</p>
        <h1>The portal is unavailable.</h1>
        <p className="muted">Please try again later or ask an organizer for help.</p>
      </section>
    </main>,
  )
} else {
  const convex = new ConvexReactClient(clientConfiguration.convexUrl)
  const authClient = createCode2CreateAuthClient(clientConfiguration.convexSiteUrl)

  const router = createBrowserRouter([
    {
      path: '*',
      element: (
        <Code2CreateAuthProvider client={convex} authClient={authClient}>
          <App authClient={authClient} />
        </Code2CreateAuthProvider>
      ),
    },
  ])

  render(<StrictMode><RouterProvider router={router} /></StrictMode>)
}

function render(children: ReactNode) {
  root.render(
    <ClientObservabilityProvider
      configuration={{
        projectToken: clientConfiguration.posthogProjectToken,
        host: clientConfiguration.posthogHost,
        deploymentEnvironment: clientConfiguration.deploymentEnvironment,
        release: clientConfiguration.releaseId,
        surface: 'participant-web',
        development: import.meta.env.DEV,
      }}
    >
      {children}
    </ClientObservabilityProvider>,
  )
}

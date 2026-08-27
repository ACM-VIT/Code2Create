import { ConvexReactClient } from 'convex/react'
import { ClientObservabilityProvider } from '@code2create/client-observability'
import { Code2CreateAuthProvider, createCode2CreateAuthClient } from '@code2create/web-auth'
import { StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'

import App from './App'
import { clientConfiguration } from './lib/config'
import './index.css'

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('The application root element is missing.')
const root = createRoot(rootElement)

if (!clientConfiguration.convexUrl || !clientConfiguration.convexSiteUrl) {
  render(
    <main className="centered"><p className="muted">Operations is unavailable. Check the event setup and try again.</p></main>,
  )
} else {
  const convex = new ConvexReactClient(clientConfiguration.convexUrl)
  const authClient = createCode2CreateAuthClient(clientConfiguration.convexSiteUrl)
  render(
    <StrictMode>
      <BrowserRouter>
        <Code2CreateAuthProvider authClient={authClient} client={convex}>
          <App authClient={authClient} />
        </Code2CreateAuthProvider>
      </BrowserRouter>
    </StrictMode>,
  )
}

function render(children: ReactNode) {
  root.render(
    <ClientObservabilityProvider
      configuration={{
        projectToken: clientConfiguration.posthogProjectToken,
        host: clientConfiguration.posthogHost,
        deploymentEnvironment: clientConfiguration.deploymentEnvironment,
        release: clientConfiguration.releaseId,
        surface: 'operations-web',
        development: import.meta.env.DEV,
      }}
    >
      {children}
    </ClientObservabilityProvider>,
  )
}

import { ConvexReactClient } from 'convex/react'
import { ClientErrorBoundary, initializeBrowserObservability } from '@code2create/client-observability'
import { Code2CreateAuthProvider, createCode2CreateAuthClient } from '@code2create/web-auth'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'

import App from './App'
import { clientConfiguration } from './lib/config'
import './index.css'

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('The application root element is missing.')
const root = createRoot(rootElement)
initializeBrowserObservability({
  dsn: clientConfiguration.sentryDsn,
  environment: clientConfiguration.deploymentEnvironment,
  release: clientConfiguration.releaseId,
  surface: 'operations-web',
})

if (!clientConfiguration.convexUrl || !clientConfiguration.convexSiteUrl) {
  root.render(
    <ClientErrorBoundary>
      <main className="centered"><p className="muted">Operations is unavailable. Check the event setup and try again.</p></main>
    </ClientErrorBoundary>,
  )
} else {
  const convex = new ConvexReactClient(clientConfiguration.convexUrl)
  const authClient = createCode2CreateAuthClient(clientConfiguration.convexSiteUrl)
  root.render(
    <ClientErrorBoundary>
      <StrictMode>
        <BrowserRouter>
          <Code2CreateAuthProvider authClient={authClient} client={convex}>
            <App authClient={authClient} />
          </Code2CreateAuthProvider>
        </BrowserRouter>
      </StrictMode>
    </ClientErrorBoundary>,
  )
}

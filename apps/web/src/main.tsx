import { ConvexReactClient } from 'convex/react'
import { ClientErrorBoundary, initializeBrowserObservability } from '@code2create/client-observability'
import { Code2CreateAuthProvider, createCode2CreateAuthClient } from '@code2create/web-auth'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App.tsx'
import { clientConfiguration } from './lib/config.ts'

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('The application root element is missing.')
const root = createRoot(rootElement)
initializeBrowserObservability({
  dsn: clientConfiguration.sentryDsn,
  environment: clientConfiguration.deploymentEnvironment,
  release: clientConfiguration.releaseId,
  surface: 'participant-web',
})

if (!clientConfiguration.convexUrl || !clientConfiguration.convexSiteUrl) {
  root.render(
    <ClientErrorBoundary>
      <main className="centered-shell">
        <section className="narrow-panel">
          <p className="eyebrow">Code2Create</p>
          <h1>Configuration needed</h1>
          <p className="muted">Set VITE_CONVEX_URL and VITE_CONVEX_SITE_URL before starting the portal.</p>
        </section>
      </main>
    </ClientErrorBoundary>,
  )
} else {
  const convex = new ConvexReactClient(clientConfiguration.convexUrl)
  const authClient = createCode2CreateAuthClient(clientConfiguration.convexSiteUrl)

  root.render(
    <ClientErrorBoundary>
      <StrictMode>
        <BrowserRouter>
          <Code2CreateAuthProvider client={convex} authClient={authClient}>
            <App authClient={authClient} />
          </Code2CreateAuthProvider>
        </BrowserRouter>
      </StrictMode>
    </ClientErrorBoundary>,
  )
}

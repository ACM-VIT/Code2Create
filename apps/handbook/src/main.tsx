import { Code2CreateAuthProvider, createCode2CreateAuthClient } from '@code2create/web-auth'
import { ConvexReactClient } from 'convex/react'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'

import App from './App'
import { clientConfiguration } from './lib/config'
import './index.css'

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('The application root element is missing.')
const root = createRoot(rootElement)

if (!clientConfiguration.convexUrl || !clientConfiguration.convexSiteUrl) {
  root.render(
    <main className="centered">
      <p className="muted">Set VITE_CONVEX_URL and VITE_CONVEX_SITE_URL.</p>
    </main>,
  )
} else {
  const convex = new ConvexReactClient(clientConfiguration.convexUrl)
  const authClient = createCode2CreateAuthClient(clientConfiguration.convexSiteUrl)

  root.render(
    <StrictMode>
      <BrowserRouter>
        <Code2CreateAuthProvider authClient={authClient} client={convex}>
          <App authClient={authClient} />
        </Code2CreateAuthProvider>
      </BrowserRouter>
    </StrictMode>,
  )
}

import { api } from '@code2create/backend/api'
import { ClientObservabilityIdentity } from '@code2create/client-observability'
import type { Code2CreateAuthClient } from '@code2create/web-auth'
import { AuthLoading, Authenticated, Unauthenticated, useQuery } from 'convex/react'
import { lazy, Suspense } from 'react'
import { Route, Routes } from 'react-router-dom'
import { eventSlug } from './lib/config'
import { EntryScreen } from './screens/EntryScreen'
import './App.css'

const ParticipantApp = lazy(() =>
  import('./ParticipantApp').then((module) => ({ default: module.ParticipantApp })),
)

export default function App({ authClient }: { authClient: Code2CreateAuthClient }) {
  const { data: session } = authClient.useSession()
  const publicState = useQuery(api.system.getPublicState, { eventSlug })

  if (publicState === undefined) {
    return <LoadingScreen />
  }

  return (
    <>
      <ClientObservabilityIdentity distinctId={session?.user.id ?? null} />
      <AuthLoading>
        <LoadingScreen />
      </AuthLoading>
      <Unauthenticated>
        <Routes>
          <Route path="*" element={<EntryScreen publicState={publicState} authClient={authClient} />} />
        </Routes>
      </Unauthenticated>
      <Authenticated>
        <Suspense fallback={<LoadingScreen />}>
          <Routes>
            <Route path="/join/:code" element={<ParticipantApp publicState={publicState} authClient={authClient} />} />
            <Route path="*" element={<ParticipantApp publicState={publicState} authClient={authClient} />} />
          </Routes>
        </Suspense>
      </Authenticated>
    </>
  )
}

function LoadingScreen() {
  return (
    <main className="centered-shell">
      <p className="muted" role="status">
        Loading…
      </p>
    </main>
  )
}

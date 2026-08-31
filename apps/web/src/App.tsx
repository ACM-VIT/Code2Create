import { api } from '@code2create/backend/api'
import { ClientObservabilityIdentity } from '@code2create/client-observability'
import type { Code2CreateAuthClient } from '@code2create/web-auth'
import { AuthLoading, Authenticated, Unauthenticated, useQuery } from 'convex/react'
import { lazy, Suspense, useEffect, useState } from 'react'
import { Route, Routes } from 'react-router-dom'
import { eventSlug } from './lib/config'
import { EntryScreen } from './screens/EntryScreen'
import { DelayedBonsai } from './components/portal/DelayedBonsai'
import { PortalScene } from './components/portal/PortalScene'
import './App.css'

const ParticipantApp = lazy(() =>
  import('./ParticipantApp').then((module) => ({ default: module.ParticipantApp })),
)

// Dev-only screen switcher. `import.meta.env.DEV` is statically false in a
// production build, so the ternary collapses and the chunk is never emitted.
const ScreenGallery = import.meta.env.DEV
  ? lazy(() => import('./dev/ScreenGallery').then((module) => ({ default: module.ScreenGallery })))
  : null

export default function App({ authClient }: { authClient: Code2CreateAuthClient }) {
  const { data: session, isPending: sessionPending } = authClient.useSession()
  const publicState = useQuery(api.system.getPublicState, { eventSlug })
  const startupReady = publicState !== undefined && !sessionPending

  // Mounted outside the loading guard so the gallery is reachable even when the
  // backend is unreachable — which is when reviewing screens matters most.
  const gallery = ScreenGallery ? (
    <Suspense fallback={null}>
      <ScreenGallery />
    </Suspense>
  ) : null

  return (
    <>
      <ClientObservabilityIdentity distinctId={session?.user.id ?? null} />
      {gallery}
      <StartupCover ready={startupReady} />
      {publicState === undefined ? null : (
        <>
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
      )}
    </>
  )
}

function LoadingScreen() {
  return <PortalScene tree="both"><DelayedBonsai /></PortalScene>
}

function StartupCover({ ready }: { ready: boolean }) {
  const [phase, setPhase] = useState<'visible' | 'leaving' | 'hidden'>('visible')

  useEffect(() => {
    if (!ready || phase !== 'visible') return
    const frame = window.requestAnimationFrame(() => setPhase('leaving'))
    return () => window.cancelAnimationFrame(frame)
  }, [phase, ready])

  if (phase === 'hidden') return null
  return (
    <div
      className="startup-cover"
      data-phase={phase}
      onTransitionEnd={(event) => {
        if (phase === 'leaving' && event.propertyName === 'opacity') setPhase('hidden')
      }}
    >
      <LoadingScreen />
    </div>
  )
}

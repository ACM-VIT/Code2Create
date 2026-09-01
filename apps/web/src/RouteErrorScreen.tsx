import { useEffect } from 'react'
import { useRouteError } from 'react-router-dom'

import { PetalCard } from './components/portal/PetalCard'
import { PortalButton } from './components/portal/PortalButton'
import { PortalScene } from './components/portal/PortalScene'

export function RouteErrorScreen() {
  const error = useRouteError()

  useEffect(() => {
    console.error(error)
  }, [error])

  return (
    <PortalScene tree="right">
      <div className="w-full max-w-[520px]" role="alert">
        <PetalCard className="px-8 py-7">
          <h1 className="mb-3 font-display font-light tracking-[-.01em] text-2xl lg:text-3xl">
            That screen didn’t load.
          </h1>
          <p className="mb-5 text-[13px] leading-relaxed text-fg/60">
            Your saved work is safe. Reload once to reconnect.
          </p>
          <PortalButton type="button" onClick={() => window.location.reload()}>
            Reload
          </PortalButton>
        </PetalCard>
      </div>
    </PortalScene>
  )
}

import { Suspense, lazy, useEffect, useState } from 'react'

/* The bonsai is the landing page's own illustration: a large inline SVG driven
   by GSAP's morph plugin. Loading it lazily keeps that weight off the first
   paint, and the reveal delay below covers the fetch, so a fast load shows
   nothing at all rather than a flash of loader. */
const TreeLoader = lazy(() =>
  import('./TreeLoader').then((module) => ({ default: module.TreeLoader })),
)

const revealDelay = 300

/**
 * The portal's waiting state: the landing timeline's bonsai, blooming on a
 * clock. Held back for a beat so quick transitions never flash it, and named
 * for the view transition (c2c-pending) so it stays sharp while the outgoing
 * surface blurs away beneath it.
 */
export function DelayedBonsai({
  compact = false,
  label = 'just a moment',
}: {
  compact?: boolean
  label?: string
}) {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const timer = window.setTimeout(() => setVisible(true), revealDelay)
    return () => window.clearTimeout(timer)
  }, [])

  if (!visible) return null

  return (
    <div className={`delayed-bonsai${compact ? ' delayed-bonsai-compact' : ''}`}>
      <Suspense fallback={null}>
        <TreeLoader label={label} variant={compact ? 'shell' : 'scene'} />
      </Suspense>
    </div>
  )
}

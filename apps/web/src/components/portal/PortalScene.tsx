import { useCallback, useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { DaybreakToggle } from './DaybreakToggle'
import { PortalSceneContext } from './portalSceneContext'
import { Petals, PETAL_RADIUS } from './Petals'

type TreePlacement = 'left' | 'right' | 'both' | 'none'

type CursorPetal = { id: number; x: number; y: number; variant: number }

/** A restrained trail: one tiny blossom petal occasionally falls from the pointer. */
function CursorPetalLayer({ petals }: { petals: readonly CursorPetal[] }) {
  return (
    <div aria-hidden className="cursor-petal-layer pointer-events-none absolute inset-0 z-[4] overflow-hidden">
      {petals.map((petal) => {
        const size = 5 + (petal.variant % 3)
        const drift = (petal.variant % 2 === 0 ? 1 : -1) * (12 + (petal.variant % 3) * 5)
        return (
          <span
            key={petal.id}
            className="cursor-petal absolute block"
            style={{
              left: `${petal.x}px`,
              top: `${petal.y}px`,
              width: `${size}px`,
              height: `${size}px`,
              background: petal.variant % 2 ? 'var(--color-petal-a)' : 'var(--color-petal-b)',
              borderRadius: PETAL_RADIUS,
              ['--cursor-drift' as string]: `${drift}px`,
              ['--cursor-fall' as string]: `${58 + (petal.variant % 4) * 9}px`,
              ['--cursor-start' as string]: `${petal.variant * 31}deg`,
              ['--cursor-end' as string]: `${210 + petal.variant * 37}deg`,
            }}
          />
        )
      })}
    </div>
  )
}

/**
 * The night-hanami stage every portal screen sits on: the rose horizon
 * gradient, the hills band, the swaying tree line, drifting petals, and the
 * vignette that keeps the centre legible. The artwork holds still; only a
 * very light petal trail falls from mouse movement.
 */
export function PortalScene({
  children,
  header,
  onSignOut,
  tree = 'left',
  branch = false,
  logo = 'corner',
  backdrop,
  fill = false,
}: {
  children: ReactNode
  header?: ReactNode
  /**
   * Pins the scene to the viewport height and lets the content own its own
   * scrolling — the conversation screens, where the thread scrolls inside
   * the page rather than with it.
   */
  fill?: boolean
  /** Signed-in screens: the roster panel under the avatars offers sign-out. */
  onSignOut?: () => void
  tree?: TreePlacement
  branch?: boolean
  /** f0a centres its own large mark in the copy instead of the corner one. */
  logo?: 'corner' | 'none'
  /** A full-bleed live layer under the artwork — the home screen's GPU sky. */
  backdrop?: ReactNode
}) {
  const showLeftTree = tree === 'left' || tree === 'both'
  const showRightTree = tree === 'right' || tree === 'both'
  const [cursorPetals, setCursorPetals] = useState<readonly CursorPetal[]>([])
  const cursorPetalId = useRef(0)
  const lastCursorPetal = useRef({ at: 0, x: -100, y: -100 })
  const cursorPetalTimers = useRef(new Set<number>())

  useEffect(() => () => {
    for (const timer of cursorPetalTimers.current) window.clearTimeout(timer)
    cursorPetalTimers.current.clear()
  }, [])

  // Only a real mouse sheds petals: a finger fires synthetic mouse moves at
  // each tap, and pointer events tell the two apart.
  const onMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== 'mouse') return
    const rect = event.currentTarget.getBoundingClientRect()
    const x = event.clientX - rect.left
    const y = event.clientY - rect.top

    const now = performance.now()
    const last = lastCursorPetal.current
    const travelled = Math.hypot(x - last.x, y - last.y)
    if (
      now - last.at < 105 ||
      travelled < 16 ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) return

    cursorPetalId.current += 1
    const petal = { id: cursorPetalId.current, x, y, variant: cursorPetalId.current % 8 }
    lastCursorPetal.current = { at: now, x, y }
    setCursorPetals((current) => [...current.slice(-9), petal])
    const timer = window.setTimeout(() => {
      setCursorPetals((current) => current.filter((item) => item.id !== petal.id))
      cursorPetalTimers.current.delete(timer)
    }, 1_850)
    cursorPetalTimers.current.add(timer)
  }, [])

  return (
    <PortalSceneContext.Provider value={{ onSignOut: onSignOut ?? null }}>
    <div
      data-portal-scene
      onPointerMove={onMove}
      className={`relative flex flex-col overflow-clip bg-wash bg-[image:var(--scene-sky)] font-ui text-fg ${
        fill ? 'h-dvh' : 'min-h-dvh'
      }`}
    >
      {backdrop}
      {/* Hills sit furthest back, bleeding past both edges so the band never
          shows a seam on narrow viewports. The root clips (not hides) its
          overflow: `hidden` on one axis turns the other into a scroll
          container, and the tree's bleed below the edge then scrolls the
          whole scene up and bares the sky under the hills. */}
      <div
        className="pointer-events-none absolute -inset-x-3 bottom-[-6px] z-0"
      >
        <img
          src="/assets/hills-band.webp"
          alt=""
          aria-hidden
          className="block w-[160%] max-w-none opacity-[var(--scene-hills-opacity)] [filter:var(--scene-hills-filter)] sm:w-full"
        />
      </div>

      <div className="pointer-events-none absolute inset-0 z-[1]">
        {showLeftTree ? (
          <img
            src="/assets/tree.webp"
            alt=""
            aria-hidden
            className="absolute bottom-[-30px] left-[-130px] w-[430px] origin-[42%_96%] animate-sway [filter:var(--scene-tree-filter)] lg:left-[-150px] lg:w-[740px]"
          />
        ) : null}
        {showRightTree ? (
          <img
            src="/assets/tree.webp"
            alt=""
            aria-hidden
            className="absolute right-[-140px] bottom-[-30px] hidden w-[600px] origin-[58%_96%] -scale-x-100 animate-sway [filter:var(--scene-tree-far-filter)] lg:block lg:right-[-170px]"
            style={{ animationDuration: '11s' }}
          />
        ) : null}
      </div>

      {branch ? (
        <img
          src="/assets/branch-plate.png"
          alt=""
          aria-hidden
          className="pointer-events-none absolute top-[-16px] left-[-70px] z-[1] hidden w-[500px] [filter:var(--scene-branch-filter)] lg:block"
        />
      ) : null}

      <Petals className="z-[2] opacity-40" />

      {/* Wordmark and the per-screen header slot ride above the artwork. */}
      <header className="pointer-events-none absolute inset-x-0 top-0 z-[6] flex items-start justify-between px-6 pt-7 lg:px-11 lg:pt-9">
        {logo === 'corner' ? (
          <Link to="/" viewTransition aria-label="Home" className="pointer-events-auto">
            <img
              src="/assets/logo.svg"
              alt="Code2Create"
              className="block w-10 drop-shadow-[0_0_14px_var(--logo-glow)] lg:w-[60px]"
            />
          </Link>
        ) : (
          <span />
        )}
        <div className="portal-header-controls pointer-events-auto flex items-start gap-2.5">
          {header}
          <div data-header-theme-toggle>
            <DaybreakToggle />
          </div>
        </div>
      </header>

      <main
        className={`relative z-[3] flex flex-1 flex-col items-center px-5 lg:px-12 ${
          fill ? 'min-h-0 justify-start pt-[84px] pb-4 lg:pt-[100px] lg:pb-6 xl:pt-9' : 'justify-center-safe pt-28 pb-16'
        }`}
      >
        {children}
      </main>

      <CursorPetalLayer petals={cursorPetals} />

      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 z-[5] bg-[image:var(--scene-vignette)]"
      />
    </div>
    </PortalSceneContext.Provider>
  )
}

import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { usePortalTheme } from '../../lib/portalTheme'
import { DaybreakToggle } from './DaybreakToggle'
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
 * vignette that keeps the centre legible. The artwork tracks the pointer at
 * three depths while a very light petal trail falls from pointer movement.
 */
export function PortalScene({
  children,
  header,
  menu,
  tree = 'left',
  branch = false,
  logo = 'corner',
  backdrop,
}: {
  children: ReactNode
  header?: ReactNode
  /**
   * Content for the mobile menu takeover. When given, small screens swap the
   * header cluster and theme toggle for a hamburger that opens a full-screen
   * menu holding this content plus the theme row; desktop is unchanged.
   */
  menu?: ReactNode
  tree?: TreePlacement
  branch?: boolean
  /** f0a centres its own large mark in the copy instead of the corner one. */
  logo?: 'corner' | 'none'
  /** A full-bleed live layer under the artwork — the home screen's GPU sky. */
  backdrop?: ReactNode
}) {
  const showLeftTree = tree === 'left' || tree === 'both'
  const showRightTree = tree === 'right' || tree === 'both'
  const [pointer, setPointer] = useState({ x: 0, y: 0 })
  const [cursorPetals, setCursorPetals] = useState<readonly CursorPetal[]>([])
  const cursorPetalId = useRef(0)
  const lastCursorPetal = useRef({ at: 0, x: -100, y: -100 })
  const cursorPetalTimers = useRef(new Set<number>())

  useEffect(() => () => {
    for (const timer of cursorPetalTimers.current) window.clearTimeout(timer)
    cursorPetalTimers.current.clear()
  }, [])

  const onMove = useCallback((event: MouseEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const x = event.clientX - rect.left
    const y = event.clientY - rect.top
    setPointer({
      x: (x / rect.width - 0.5) * 2,
      y: (y / rect.height - 0.5) * 2,
    })

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

  const treeShift = `translate(${pointer.x * -16}px, ${pointer.y * -9}px)`
  const hillsShift = `translate(${pointer.x * -7}px, ${pointer.y * -4}px)`
  const branchShift = `translate(${pointer.x * 12}px, ${pointer.y * 7}px)`

  return (
    <div
      data-portal-scene
      onMouseMove={onMove}
      className="relative flex min-h-dvh flex-col overflow-hidden bg-wash bg-[image:var(--scene-sky)] font-ui text-fg"
    >
      {backdrop}
      {/* Hills sit furthest back, bleeding past both edges so the band never
          shows a seam on narrow viewports. */}
      <div
        className="pointer-events-none absolute -inset-x-3 bottom-0 z-0"
        style={{ transform: hillsShift }}
      >
        <img
          src="/assets/hills-band.webp"
          alt=""
          aria-hidden
          className="w-[160%] max-w-none opacity-[var(--scene-hills-opacity)] [filter:var(--scene-hills-filter)] sm:w-full"
        />
      </div>

      <div className="pointer-events-none absolute inset-0 z-[1]" style={{ transform: treeShift }}>
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
          style={{ transform: branchShift }}
          className="pointer-events-none absolute top-[-16px] left-[-70px] z-[1] hidden w-[500px] [filter:var(--scene-branch-filter)] lg:block"
        />
      ) : null}

      <Petals className="z-[2] opacity-40" />

      {/* Wordmark and the per-screen header slot ride above the artwork. */}
      <header className="pointer-events-none absolute inset-x-0 top-0 z-[6] flex items-start justify-between px-6 pt-7 lg:px-11 lg:pt-9">
        {logo === 'corner' ? (
          <img
            src="/assets/logo.svg"
            alt="Code2Create"
            className="pointer-events-auto w-[52px] drop-shadow-[0_0_14px_var(--logo-glow)] lg:w-[60px]"
          />
        ) : (
          <span />
        )}
        <div
          className={`pointer-events-auto items-start gap-2.5 ${menu ? 'hidden lg:flex' : 'flex'}`}
        >
          {header}
          <DaybreakToggle />
        </div>
        {menu ? <SceneMenuButton menu={menu} /> : null}
      </header>

      <main className="relative z-[3] flex flex-1 flex-col items-center justify-center px-5 pt-28 pb-16 lg:px-12">
        {children}
      </main>

      <CursorPetalLayer petals={cursorPetals} />

      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 z-[5] bg-[image:var(--scene-vignette)]"
      />
    </div>
  )
}

/**
 * The small-screen menu: a hamburger in the avatar-circle family that opens
 * a full-screen takeover — the passed content (team details and the like)
 * stacked over a theme-tinted backdrop, with the light switch at the end.
 */
function SceneMenuButton({ menu }: { menu: ReactNode }) {
  const [open, setOpen] = useState(false)
  const theme = usePortalTheme()

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    document.documentElement.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.documentElement.style.overflow = ''
    }
  }, [open])

  return (
    <>
      <button
        type="button"
        aria-label="Open menu"
        onClick={() => setOpen(true)}
        className="pointer-events-auto flex size-10 flex-none items-center justify-center rounded-full border-2 border-rose/70 bg-avatar text-fg/80 transition-colors hover:border-rose-light lg:hidden"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
          <path d="M4 7h16M4 12h16M4 17h16" />
        </svg>
      </button>

      {open ? (
        /* The classic overlay nav: a translucent scrim the scene still shows
           through, with the options floating in the middle of the screen. */
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Menu"
          className="pointer-events-auto fixed inset-0 z-[8] flex flex-col overflow-y-auto bg-wash/75 backdrop-blur-xl lg:hidden"
        >
          {/* A rose breath at the top and a few drifting petals keep the
              scrim from reading as a flat void. */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_75%_50%_at_50%_-10%,var(--glow-rose-soft),transparent_60%)]"
          />
          <Petals className="opacity-20" />
          <div className="relative flex flex-none items-center justify-between px-6 pt-7">
            <img src="/assets/logo.svg" alt="Code2Create" className="w-[30px]" />
            <button
              type="button"
              aria-label="Close menu"
              autoFocus
              onClick={() => setOpen(false)}
              className="flex size-10 flex-none items-center justify-center rounded-full border-2 border-rose/70 bg-avatar text-fg/80 transition-colors hover:border-rose-light"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>
          <div className="relative flex flex-1 flex-col items-center justify-center gap-10 px-6 py-10">
            {menu}
            <div className="flex flex-col items-center gap-2">
              <DaybreakToggle />
              <span className="text-[11px] text-fg/50">
                {theme === 'daybreak' ? 'daybreak' : 'night'}
              </span>
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}

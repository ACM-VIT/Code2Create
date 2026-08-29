import { useCallback, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { Petals, PETAL_RADIUS } from './Petals'

type TreePlacement = 'left' | 'right' | 'both' | 'none'

type Burst = { id: number; x: number; y: number }

/** The mockup's burst: nine petals thrown out radially, fading over 1.4s. */
function BurstLayer({ bursts }: { bursts: readonly Burst[] }) {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 z-[4]">
      {bursts.flatMap((burst) =>
        Array.from({ length: 9 }, (_, index) => {
          const angle = (index / 9) * Math.PI * 2 + (burst.id % 7) * 0.3
          const distance = 55 + (index % 3) * 34
          const size = 9 + (index % 3) * 4
          return (
            <span
              key={`${burst.id}-${index}`}
              className="absolute block"
              style={{
                left: `${burst.x}px`,
                top: `${burst.y}px`,
                width: `${size}px`,
                height: `${size}px`,
                background: index % 2 ? '#feb4cb' : '#d884a2',
                borderRadius: PETAL_RADIUS,
                ['--bx' as string]: `${Math.cos(angle) * distance}px`,
                ['--by' as string]: `${Math.sin(angle) * distance * 0.7 + 46}px`,
                animation: 'c2cburst 1.4s ease-out forwards',
              }}
            />
          )
        }),
      )}
    </div>
  )
}

/**
 * The night-hanami stage every portal screen sits on: the rose horizon
 * gradient, the hills band, the swaying tree line, drifting petals, and the
 * vignette that keeps the centre legible. The artwork tracks the pointer at
 * three depths and throws a petal burst where the backdrop is clicked.
 */
export function PortalScene({
  children,
  header,
  tree = 'left',
  branch = false,
  logo = 'corner',
}: {
  children: ReactNode
  header?: ReactNode
  tree?: TreePlacement
  branch?: boolean
  /** f0a centres its own large mark in the copy instead of the corner one. */
  logo?: 'corner' | 'none'
}) {
  const showLeftTree = tree === 'left' || tree === 'both'
  const showRightTree = tree === 'right' || tree === 'both'
  const [pointer, setPointer] = useState({ x: 0, y: 0 })
  const [bursts, setBursts] = useState<readonly Burst[]>([])
  const burstId = useRef(0)

  const onMove = useCallback((event: MouseEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    setPointer({
      x: ((event.clientX - rect.left) / rect.width - 0.5) * 2,
      y: ((event.clientY - rect.top) / rect.height - 0.5) * 2,
    })
  }, [])

  const onClick = useCallback((event: MouseEvent<HTMLDivElement>) => {
    // Only the backdrop throws petals; clicks on controls belong to them.
    if ((event.target as HTMLElement).closest('button, a, input, textarea, select, label')) return
    const rect = event.currentTarget.getBoundingClientRect()
    burstId.current += 1
    const burst = {
      id: burstId.current,
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    }
    setBursts((current) => [...current.slice(-3), burst])
    window.setTimeout(
      () => setBursts((current) => current.filter((item) => item.id !== burst.id)),
      1500,
    )
  }, [])

  const treeShift = `translate(${pointer.x * -16}px, ${pointer.y * -9}px)`
  const hillsShift = `translate(${pointer.x * -7}px, ${pointer.y * -4}px)`
  const branchShift = `translate(${pointer.x * 12}px, ${pointer.y * 7}px)`

  return (
    <div
      data-portal-scene
      onMouseMove={onMove}
      onClick={onClick}
      className="relative flex min-h-dvh flex-col overflow-hidden bg-[linear-gradient(180deg,#0c0004_58%,#7c3350_118%,#a04263_138%,#e3a9bf_172%)] font-ui text-paper"
    >
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
          className="w-[160%] max-w-none opacity-40 sm:w-full"
        />
      </div>

      <div className="pointer-events-none absolute inset-0 z-[1]" style={{ transform: treeShift }}>
        {showLeftTree ? (
          <img
            src="/assets/tree.webp"
            alt=""
            aria-hidden
            className="absolute bottom-[-30px] left-[-130px] w-[430px] origin-[42%_96%] animate-sway brightness-[.72] saturate-[.92] lg:left-[-150px] lg:w-[740px]"
          />
        ) : null}
        {showRightTree ? (
          <img
            src="/assets/tree.webp"
            alt=""
            aria-hidden
            className="absolute right-[-140px] bottom-[-30px] hidden w-[600px] origin-[58%_96%] -scale-x-100 animate-sway brightness-[.55] saturate-[.8] lg:block lg:right-[-170px]"
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
          className="pointer-events-none absolute top-[-16px] left-[-70px] z-[1] hidden w-[500px] brightness-[.85] lg:block"
        />
      ) : null}

      <Petals className="z-[2] opacity-40" />

      {/* Wordmark and the per-screen header slot ride above the artwork. */}
      <header className="pointer-events-none absolute inset-x-0 top-0 z-[6] flex items-start justify-between px-6 pt-7 lg:px-11 lg:pt-9">
        {logo === 'corner' ? (
          <img
            src="/assets/logo.svg"
            alt="Code2Create"
            className="pointer-events-auto w-[26px] drop-shadow-[0_0_14px_rgba(216,132,162,.5)] lg:w-[30px]"
          />
        ) : (
          <span />
        )}
        {header ? <div className="pointer-events-auto">{header}</div> : null}
      </header>

      <main className="relative z-[3] flex flex-1 flex-col items-center justify-center px-5 pt-28 pb-16 lg:px-12">
        {children}
      </main>

      <BurstLayer bursts={bursts} />

      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 z-[5] bg-[radial-gradient(ellipse_at_50%_32%,transparent_46%,rgba(6,0,2,.48)_100%)]"
      />
    </div>
  )
}

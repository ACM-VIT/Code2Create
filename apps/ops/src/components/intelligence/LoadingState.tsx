import { useEffect, useState } from 'react'

/* Beautiful UI loading state — pixel-grid loader for long-running work.
 * Drive: square cells, chevron wavefront driving right (two fronts in flight).
 * Dots: same wavefront, circular cells. Orbit: a comet lapping the perimeter.
 * Paired with a shimmering label and a live elapsed timer in mono figures. */

const chevron = Array.from({ length: 9 }, (_, index) => {
  const row = Math.floor(index / 3)
  const column = index % 3
  return (column + Math.abs(row - 1)) * 90
})

const orbitOrder = [0, 1, 2, 5, 8, 7, 6, 3]
const orbit = Array.from({ length: 9 }, (_, index) => {
  const step = orbitOrder.indexOf(index)
  return step === -1 ? null : step * 110
})

export type LoadingVariant = 'drive' | 'dots' | 'orbit'

const patterns: Record<LoadingVariant, {
  delays: (number | null)[]
  dur: number
  round: boolean
}> = {
  drive: { delays: chevron, dur: 650, round: false },
  dots: { delays: chevron, dur: 650, round: true },
  orbit: { delays: orbit, dur: 950, round: false },
}

function useElapsed() {
  const [deciseconds, setDeciseconds] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setDeciseconds((current) => current + 1), 100)
    return () => clearInterval(timer)
  }, [])
  const total = deciseconds / 10
  if (total < 60) return `${total.toFixed(1)}s`
  return `${Math.floor(total / 60)}m ${(total % 60).toFixed(1)}s`
}

export function LoadingState({
  label = 'Working',
  variant = 'drive',
}: {
  label?: string
  variant?: LoadingVariant
}) {
  const elapsed = useElapsed()
  const { delays, dur, round } = patterns[variant]

  return (
    <div className="flex w-fit items-center gap-2.5">
      <span aria-hidden className="grid grid-cols-[repeat(3,4px)] gap-[1.5px]">
        {delays.map((delay, index) => (
          <span
            className={`size-[4px] bg-ink ${round ? 'rounded-full' : 'rounded-[1px]'}`}
            key={index}
            style={{
              opacity: delay === null ? 0.07 : 0.15,
              animation: delay === null
                ? 'none'
                : `pixel-on ${dur}ms ease-in-out ${delay}ms infinite`,
            }}
          />
        ))}
      </span>
      <ShimmerText>{label}</ShimmerText>
      <span className="font-mono text-[12px] text-ink-3 tabular-nums">
        {elapsed}
      </span>
    </div>
  )
}

export function ShimmerText({ children }: { children: string }) {
  return (
    <span
      className="bg-clip-text text-[13px] font-medium whitespace-nowrap text-transparent"
      style={{
        backgroundImage:
          'linear-gradient(90deg, var(--color-ink-3) 35%, var(--color-ink) 50%, var(--color-ink-3) 65%)',
        backgroundSize: '200% 100%',
        animation: 'shimmer-text 1.4s linear infinite',
      }}
    >
      {children}
    </span>
  )
}

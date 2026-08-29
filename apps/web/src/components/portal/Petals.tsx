import { useMemo } from 'react'

// The mockup's petalLayer(11, 1200, 7, 3, .38, 15): eleven petals stepped
// 173px apart across a 1200px frame, three sizes, a single low opacity, and a
// slow 15-22s fall started mid-flight by a negative delay.
const COUNT = 11
const FRAME = 1200
const STEP = 173

/** The organic petal blob the mockup uses — not a symmetric leaf. */
export const PETAL_RADIUS = '76% 24% 70% 30% / 60% 55% 45% 40%'

/**
 * The falling sakura layer. Positions are derived once per mount from a fixed
 * step so the drift reads as scattered without re-randomising on every render
 * (which would restart each petal's animation).
 */
export function Petals({ className = '' }: { className?: string }) {
  const petals = useMemo(
    () =>
      Array.from({ length: COUNT }, (_, index) => ({
        // Expressed as a percentage of the frame so the field spreads across
        // any viewport rather than bunching into the mockup's 1200px card.
        left: (((index * STEP) % FRAME) / FRAME) * 100,
        duration: 15 + (index % 5) * 1.7,
        delay: -(index * 2.7),
        size: 7 + (index % 3) * 3,
        color: index % 2 ? '#feb4cb' : '#d884a2',
      })),
    [],
  )

  return (
    <div aria-hidden className={`pointer-events-none absolute inset-0 overflow-hidden ${className}`}>
      {petals.map((petal, index) => (
        <span
          key={index}
          className="absolute block"
          style={{
            left: `${petal.left}%`,
            top: '-40px',
            width: `${petal.size}px`,
            height: `${petal.size}px`,
            background: petal.color,
            borderRadius: PETAL_RADIUS,
            opacity: 0.38,
            animation: `c2cfall ${petal.duration}s linear ${petal.delay}s infinite`,
          }}
        />
      ))}
    </div>
  )
}

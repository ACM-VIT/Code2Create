import { useMemo } from 'react'

const COUNT = 11
const FRAME = 1200
const STEP = 173

export const PETAL_RADIUS = '76% 24% 70% 30% / 60% 55% 45% 40%'

export function Petals({ className = '' }: { className?: string }) {
  const petals = useMemo(
    () =>
      Array.from({ length: COUNT }, (_, index) => ({
        left: (((index * STEP) % FRAME) / FRAME) * 100,
        duration: 15 + (index % 5) * 1.7,
        delay: -(index * 2.7),
        size: 7 + (index % 3) * 3,
        color: index % 2 ? 'var(--color-petal-a)' : 'var(--color-petal-b)',
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

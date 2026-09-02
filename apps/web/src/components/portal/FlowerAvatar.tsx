import type { ReactNode } from 'react'
import { hashSeed, VARIANT_COUNT } from './flowerVariants'

const TINTS = [
  { petal: '#feb4cb', heart: '#a04263' },
  { petal: '#e3a9bf', heart: '#a04263' },
  { petal: '#d884a2', heart: '#fdd9e4' },
  { petal: '#f4c2d3', heart: '#c26787' },
] as const


function ring(count: number, offset: number, shape: (key: string, angle: number) => ReactNode) {
  return Array.from({ length: count }, (_, index) =>
    shape(`p${index}`, (index * 360) / count + offset),
  )
}

const BLOOMS: readonly ((petal: string) => ReactNode)[] = [
  // ume · five round petals
  (petal) =>
    ring(5, 0, (key, angle) => (
      <circle key={key} cx="12" cy="6.6" r="4.1" fill={petal} transform={`rotate(${angle} 12 12)`} />
    )),
  // kikyo · five soft points
  (petal) =>
    ring(5, 0, (key, angle) => (
      <path
        key={key}
        d="M12 2.6c1.9 2.6 2.6 4.9 2.6 6.7 0 2-1.2 3.1-2.6 3.1S9.4 11.3 9.4 9.3c0-1.8.7-4.1 2.6-6.7z"
        fill={petal}
        transform={`rotate(${angle} 12 12)`}
      />
    )),
  // ajisai · four rounded diamonds
  (petal) =>
    ring(4, 0, (key, angle) => (
      <path
        key={key}
        d="M12 3.2c2.3 1.7 3.5 3.4 3.5 5.1 0 2.1-1.6 3.5-3.5 3.5S8.5 10.4 8.5 8.3c0-1.7 1.2-3.4 3.5-5.1z"
        fill={petal}
        transform={`rotate(${angle} 12 12)`}
      />
    )),
  // kiku · twelve thin rays
  (petal) =>
    ring(12, 0, (key, angle) => (
      <ellipse key={key} cx="12" cy="6.4" rx="1.5" ry="4.6" fill={petal} transform={`rotate(${angle} 12 12)`} />
    )),
  // tsubaki · five petals with a paler inner layer
  (petal) => (
    <>
      {ring(5, 0, (key, angle) => (
        <circle key={key} cx="12" cy="6.9" r="3.9" fill={petal} transform={`rotate(${angle} 12 12)`} />
      ))}
      {ring(5, 36, (key, angle) => (
        <circle key={`i${key}`} cx="12" cy="8.6" r="2.6" fill="#fff" opacity=".22" transform={`rotate(${angle} 12 12)`} />
      ))}
    </>
  ),
]

// The lead's sakura: five notched petals over quiet stamens.
const SAKURA_PETAL =
  'M12 3.2c1.4 1.5 2.9 2.9 2.9 4.9a2.9 2.9 0 0 1-2 2.8l-.9-1-.9 1a2.9 2.9 0 0 1-2-2.8c0-2 1.5-3.4 2.9-4.9z'

function Sakura() {
  return (
    <>
      {ring(5, 0, (key, angle) => (
        <path key={key} d={SAKURA_PETAL} fill="#feb4cb" transform={`rotate(${angle} 12 12)`} />
      ))}
      {ring(5, 36, (key, angle) => (
        <g key={`s${key}`} transform={`rotate(${angle} 12 12)`}>
          <line x1="12" y1="12" x2="12" y2="8.6" stroke="#a04263" strokeWidth=".7" />
          <circle cx="12" cy="8.2" r=".55" fill="#a04263" />
        </g>
      ))}
    </>
  )
}



/**
 * One member's bloom. `variant` (from assignFlowerVariants) picks the flower
 * and tint — falling back to a hash of `seed` alone — while `lead` overrides
 * with the sakura. Size it with `size` or a `className`; the svg is a block
 * so flex centring holds it exactly in the middle of its circle.
 */
export function Flower({
  seed,
  lead = false,
  variant,
  size,
  className = '',
}: {
  seed: string
  lead?: boolean
  variant?: number
  size?: number
  className?: string
}) {
  const resolved = variant ?? hashSeed(seed) % VARIANT_COUNT
  const bloom = BLOOMS[resolved % BLOOMS.length]
  const tint = TINTS[Math.floor(resolved / BLOOMS.length) % TINTS.length]
  return (
    <svg
      {...(size === undefined ? {} : { width: size, height: size })}
      viewBox="0 0 24 24"
      aria-hidden
      className={`block [filter:var(--flower-filter)] ${className}`}
    >
      {lead || !bloom || !tint ? (
        <Sakura />
      ) : (
        <>
          {bloom(tint.petal)}
          <circle cx="12" cy="12" r="1.7" fill={tint.heart} />
        </>
      )}
    </svg>
  )
}

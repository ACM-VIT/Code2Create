import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion'
import { COLORS, CLAMP } from '../theme.ts'
import { FACETS, LOGO_VIEWBOX, PLATE, PLATE_STROKE_WIDTH, RIM } from './logoPaths.ts'

export const LogoMark: React.FC<{ start: number; height: number }> = ({ start, height }) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()

  const punchRaw = spring({
    frame,
    fps,
    delay: start,
    config: { damping: 200, mass: 0.7 },
  })
  const punch = interpolate(punchRaw, [0, 0.95], [0, 1], CLAMP)
  const scale = interpolate(punch, [0, 1], [1.55, 1])
  const opacity = interpolate(punch, [0, 0.35], [0, 1], CLAMP)

  const facetIn = (i: number) => {
    const p = spring({
      frame,
      fps,
      delay: start + 6 + i * 3,
      config: { damping: 200 },
    })
    return interpolate(p, [0, 0.95], [0, 1], CLAMP)
  }

  return (
    <svg
      viewBox={LOGO_VIEWBOX}
      style={{
        height,
        opacity,
        transform: `scale(${scale})`,
        filter: 'drop-shadow(0 20px 44px rgba(12, 0, 4, 0.55))',
      }}
    >
      <defs>
        {FACETS.map((facet, i) => (
          <linearGradient key={i} id={`c2cf${i}`} x1="0" y1="0" x2="0.35" y2="1">
            <stop offset="0" stopColor={facet.from} />
            <stop offset="1" stopColor={facet.to} />
          </linearGradient>
        ))}
      </defs>
      <path d={RIM} fill={COLORS.white} />
      <path
        d={PLATE}
        fill="#2C2C2C"
        stroke={COLORS.roseDeep}
        strokeWidth={PLATE_STROKE_WIDTH}
        strokeMiterlimit={10}
      />
      {FACETS.map((facet, i) => (
        <path key={i} d={facet.d} fill={`url(#c2cf${i})`} opacity={facetIn(i)} />
      ))}
    </svg>
  )
}

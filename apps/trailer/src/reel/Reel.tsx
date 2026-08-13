import { AbsoluteFill, Easing, Img, interpolate, random, Sequence, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion'
import { Audio } from '@remotion/media'
import { noise3D } from '@remotion/noise'
import { Wordmark } from '../components/Wordmark.tsx'
import { LogoMark } from '../components/LogoMark.tsx'
import { FACETS, LOGO_VIEWBOX, PLATE, RIM } from '../components/logoPaths.ts'
import { Grain, Vignette } from '../components/Grade.tsx'
import { COLORS, R, CLAMP } from '../theme.ts'
import { launch } from '../fonts.ts'


const lerp = (a: number, b: number, t: number) => a + (b - a) * t

const LOGO_Y = 600
const LOGO_H = 300
const ASSEMBLE_H = 1200


const LANTERN_FLIGHTS = [
  { x: 130, size: 140, sway: 36, glow: 0.4, from: 0, to: 430, y0: 1250, y1: -280 },
  { x: 640, size: 280, sway: 26, glow: 0.5, from: 36, to: 470, y0: 1780, y1: -340 },
  { x: 900, size: 82, sway: 28, glow: 0.32, from: 120, to: 640, y0: 1560, y1: 100 },
  { x: 80, size: 190, sway: 24, glow: 0.5, from: 340, to: 660, y0: 1800, y1: 360 },
]

const World: React.FC = () => {
  const frame = useCurrentFrame()
  const settle = interpolate(frame, [0, 220], [0, 1], {
    easing: Easing.bezier(0.45, 0, 0.55, 1),
    ...CLAMP,
  })
  const drift = lerp(0, -64, settle)
  const breathe = lerp(1.05, 1, settle)
  const sway = noise3D('bower', 0, 0, frame / 120) * 0.35
  return (
    <AbsoluteFill style={{ backgroundColor: COLORS.night }}>
      <AbsoluteFill
        style={{
          background: `radial-gradient(140% 90% at 50% 112%, rgba(109, 43, 66, 0.5) 0%, rgba(109, 43, 66, 0.16) 48%, transparent 74%)`,
        }}
      />
      {LANTERN_FLIGHTS.map((l, i) => {
        if (frame < l.from) {
          return null
        }
        const p = interpolate(frame, [l.from, l.to], [0, 1], {
          easing: Easing.bezier(0.45, 0, 0.55, 1),
          ...CLAMP,
        })
        const y = lerp(l.y0, l.y1, p)
        const swayX = noise3D(`sl${i}`, 0, 0, frame / 82) * l.sway
        const flicker = 0.84 + noise3D(`sf${i}`, 0, 0, frame / 7) * 0.1
        return (
          <div key={i}>
            <div
              style={{
                position: 'absolute',
                left: l.x - l.size * 1.05,
                top: y - l.size * 0.85,
                width: l.size * 3.1,
                height: l.size * 3.1,
                opacity: l.glow * flicker,
                mixBlendMode: 'screen',
                background:
                  'radial-gradient(50% 50% at 50% 50%, rgba(240, 138, 46, 0.5) 0%, rgba(240, 138, 46, 0.13) 50%, transparent 74%)',
                transform: `translateX(${swayX}px)`,
              }}
            />
            <Img
              src={staticFile('lantern.png')}
              style={{
                position: 'absolute',
                left: l.x,
                top: y,
                width: l.size,
                opacity: flicker,
                transform: `translateX(${swayX}px) rotate(${noise3D(`st${i}`, 0, 0, frame / 64) * 4}deg)`,
              }}
            />
          </div>
        )
      })}
      <Img
        src={staticFile('tree.png')}
        style={{
          position: 'absolute',
          width: 1600,
          right: -540,
          top: -200,
          opacity: 0.85,
          filter: 'blur(3px) brightness(0.74) saturate(0.92)',
          transform: `scaleX(-1) translateY(${drift * 0.5}px) scale(${breathe})`,
          maskImage: 'linear-gradient(180deg, black 52%, transparent 76%)',
        }}
      />
      <AbsoluteFill
        style={{
          mixBlendMode: 'screen',
          background:
            'radial-gradient(70% 40% at 74% 4%, rgba(255, 246, 241, 0.15) 0%, rgba(241, 206, 223, 0.06) 46%, transparent 72%)',
        }}
      />
      <Img
        src={staticFile('tree.png')}
        style={{
          position: 'absolute',
          width: 1900,
          left: -520,
          top: -90,
          filter: 'blur(0.6px) saturate(1.06) contrast(1.03)',
          transform: `translateY(${drift}px) scale(${breathe}) rotate(${sway}deg)`,
          transformOrigin: '25% 20%',
          maskImage: 'linear-gradient(180deg, black 56%, transparent 80%)',
        }}
      />
      <Img
        src={staticFile('acm-vit.svg')}
        style={{
          position: 'absolute',
          left: 540 - 150,
          top: 1580,
          width: 300,
          opacity: interpolate(frame, [14, 38, 200, 224], [0, 0.6, 0.6, 0], CLAMP),
        }}
      />
    </AbsoluteFill>
  )
}

const DarkPetals: React.FC<{ count: number; dim: number }> = ({ count, dim }) => {
  const frame = useCurrentFrame()
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      {Array.from({ length: count }, (_, i) => {
        const speed = 0.8 + random(`dp${i}`) * 0.9
        const y = ((frame * speed + random(`dq${i}`) * 2300) % 2300) - 190
        const x = random(`dx${i}`) * 1080 + noise3D(`dw${i}`, 0, 0, frame / 80) * 60
        const size = 40 + random(`dz${i}`) * 55
        return (
          <Img
            key={i}
            src={staticFile('petal.png')}
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              width: size,
              opacity: dim,
              transform: `translate(${x}px, ${y}px) rotate(${random(`dr${i}`) * 360 + frame * 0.45}deg) rotateX(${noise3D(`dt${i}`, 0, 0, frame / 42) * 50}deg)`,
            }}
          />
        )
      })}
    </AbsoluteFill>
  )
}


const SPREAD = [
  { dx: 42, dy: -50, rot: 38 },
  { dx: -52, dy: -25, rot: -30 },
  { dx: 48, dy: 35, rot: 28 },
  { dx: -44, dy: 42, rot: -40 },
  { dx: 4, dy: 58, rot: 18 },
]

const AssembleMark: React.FC = () => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  if (frame < R.flight) {
    return null
  }
  const pullRaw = spring({ frame, fps, delay: R.lockup, config: { damping: 200, mass: 1.5 } })
  const pull = interpolate(pullRaw, [0, 0.95], [0, 1], CLAMP)
  const height = lerp(ASSEMBLE_H, LOGO_H, pull)
  const cy = lerp(880, LOGO_Y, pull)
  const rimDraw = interpolate(frame, [R.snap, R.snap + 24], [1, 0], {
    easing: Easing.out(Easing.cubic),
    ...CLAMP,
  })
  const rimFill = interpolate(frame, [R.snap + 18, R.snap + 30], [0, 1], CLAMP)
  const plateIn = interpolate(frame, [R.snap, R.snap + 10], [0, 1], CLAMP)
  const impact = interpolate(frame, [R.snap, R.snap + 14], [1.035, 1], {
    easing: Easing.out(Easing.cubic),
    ...CLAMP,
  })
  const settled = frame >= R.snap + 12
  if (settled) {
    return (
      <div
        style={{
          position: 'absolute',
          left: 540,
          top: cy,
          transform: `translate(-50%, -50%) scale(${impact})`,
        }}
      >
        <LogoMark start={R.snap - 40} height={height} />
      </div>
    )
  }
  return (
    <div
      style={{
        position: 'absolute',
        left: 540,
        top: cy,
        transform: `translate(-50%, -50%) scale(${impact})`,
      }}
    >
      <svg viewBox={LOGO_VIEWBOX} style={{ height, overflow: 'visible', display: 'block' }}>
        <path d={RIM} fill={COLORS.white} opacity={rimFill} />
        <path
          d={RIM}
          fill="none"
          stroke={COLORS.white}
          strokeWidth={1.2}
          pathLength={1}
          strokeDasharray={1}
          strokeDashoffset={rimDraw}
          opacity={rimFill < 1 ? 0.95 : 0}
          style={{ filter: 'drop-shadow(0 0 8px rgba(250, 251, 251, 0.6))' }}
        />
        <g>
          <path
            d={PLATE}
            fill="#2C2C2C"
            stroke={COLORS.roseDeep}
            strokeWidth={0.24}
            opacity={plateIn}
          />
          {FACETS.map((facet, i) => {
            const s = SPREAD[i] ?? { dx: 0, dy: 90, rot: 0 }
            const drift = interpolate(frame, [R.flight, R.snap - 34], [0, 0.42], {
              easing: Easing.bezier(0.45, 0, 0.55, 1),
              ...CLAMP,
            })
            const commit = interpolate(frame, [R.snap - 34 + i * 2, R.snap + i * 2 - 4], [0, 1], {
              easing: Easing.in(Easing.cubic),
              ...CLAMP,
            })
            const p = Math.min(1, drift + commit * (1 - drift))
            const wobble = noise3D(`fw${i}`, 0, 0, frame / 60) * (1 - p) * 6
            const appear = interpolate(frame, [R.flight + i * 3, R.flight + 16 + i * 3], [0, 1], CLAMP)
            const shimmer = 0.82 + Math.abs(noise3D(`fs${i}`, 0, 0, frame / 22)) * 0.18
            return (
              <path
                key={i}
                d={facet.d}
                fill={facet.fill}
                opacity={(p >= 0.99 ? 1 : shimmer) * appear}
                style={{
                  transform: `translate(${(1 - p) * s.dx}px, ${(1 - p) * s.dy}px) rotate(${(1 - p) * s.rot + wobble}deg)`,
                  transformBox: 'fill-box',
                  transformOrigin: 'center',
                  ...(p < 0.85 ? { filter: `blur(${(1 - p) * 1.6}px)` } : {}),
                }}
              />
            )
          })}
        </g>
      </svg>
    </div>
  )
}

const PullPetals: React.FC = () => {
  const frame = useCurrentFrame()
  if (frame < R.snap - 32 || frame > R.snap + 2) {
    return null
  }
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      {Array.from({ length: 8 }, (_, i) => {
        const start = R.snap - 32 + random(`pu${i}`) * 10
        const p = interpolate(frame, [start, R.snap - 2], [0, 1], {
          easing: Easing.in(Easing.quad),
          ...CLAMP,
        })
        if (p === 0 || p >= 1) {
          return null
        }
        const angle = random(`pa${i}`) * Math.PI * 2
        const dist = (1 - p) * (420 + random(`pd${i}`) * 380)
        const size = (46 + random(`pz${i}`) * 40) * (1 - p * 0.5)
        return (
          <Img
            key={i}
            src={staticFile('petal.png')}
            style={{
              position: 'absolute',
              left: 540 + Math.cos(angle + p * 1.6) * dist - size / 2,
              top: 880 + Math.sin(angle + p * 1.6) * dist * 0.9 - size / 2,
              width: size,
              opacity: Math.min(1, p * 3) * (1 - p * 0.4),
              transform: `rotate(${random(`pr${i}`) * 360 + p * 300}deg)`,
            }}
          />
        )
      })}
    </AbsoluteFill>
  )
}

const SnapImpact: React.FC = () => {
  const frame = useCurrentFrame()
  const flash = interpolate(frame, [R.snap - 1, R.snap + 3, R.snap + 16], [0, 0.85, 0], CLAMP)
  const ringP = interpolate(frame, [R.snap, R.snap + 28], [0, 1], {
    easing: Easing.out(Easing.cubic),
    ...CLAMP,
  })
  const burstP = interpolate(frame, [R.snap, R.snap + 26], [0, 1], {
    easing: Easing.out(Easing.cubic),
    ...CLAMP,
  })
  if (frame < R.snap - 2 || frame > R.snap + 34) {
    return null
  }
  const ringR = 90 + ringP * 660
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      {burstP > 0 && burstP < 1
        ? Array.from({ length: 10 }, (_, i) => {
            const angle = (i / 10) * Math.PI * 2 + random(`sb${i}`) * 0.5
            const dist = burstP * (260 + random(`sd${i}`) * 380)
            const size = (40 + random(`sz${i}`) * 46) * (1 - burstP * 0.3)
            return (
              <Img
                key={i}
                src={staticFile('petal.png')}
                style={{
                  position: 'absolute',
                  left: 540 + Math.cos(angle) * dist - size / 2,
                  top: 880 + Math.sin(angle) * dist * 0.9 - size / 2,
                  width: size,
                  opacity: 1 - burstP,
                  transform: `rotate(${random(`sr${i}`) * 360 + burstP * 220}deg)`,
                }}
              />
            )
          })
        : null}
      {ringP < 1 ? (
        <div
          style={{
            position: 'absolute',
            left: 540 - ringR,
            top: 880 - ringR,
            width: ringR * 2,
            height: ringR * 2,
            borderRadius: 999,
            border: `2.5px solid rgba(241, 206, 223, ${0.65 * (1 - ringP)})`,
          }}
        />
      ) : null}
      {flash > 0 ? <AbsoluteFill style={{ backgroundColor: '#FBEDF2', opacity: flash }} /> : null}
    </AbsoluteFill>
  )
}


const Moon: React.FC<{ opacity: number }> = ({ opacity }) => {
  const frame = useCurrentFrame()
  const halo = 0.16 + Math.abs(noise3D('moon', 0, 0, frame / 90)) * 0.06
  return (
    <div style={{ position: 'absolute', inset: 0, opacity }}>
      <div
        style={{
          position: 'absolute',
          left: 790 - 150,
          top: 350 - 150,
          width: 300,
          height: 300,
          opacity: halo,
          mixBlendMode: 'screen',
          background:
            'radial-gradient(50% 50% at 50% 50%, rgba(255, 242, 233, 0.9) 0%, rgba(255, 242, 233, 0.2) 45%, transparent 72%)',
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: 790 - 46,
          top: 350 - 46,
          width: 92,
          height: 92,
          borderRadius: 999,
          background:
            'radial-gradient(50% 50% at 44% 40%, #FFF6ED 0%, #F3DECE 70%, rgba(243, 222, 206, 0.25) 100%)',
          opacity: 0.9,
          filter: 'blur(1px)',
        }}
      />
    </div>
  )
}

const NightWorld: React.FC = () => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  if (frame < R.night - 10) {
    return null
  }
  const inRaw = spring({ frame, fps, delay: R.night, config: { mass: 5, damping: 200 } })
  const p = interpolate(inRaw, [0, 0.95], [0, 1], CLAMP)
  const shimmer = noise3D('fshim', 0, 0, frame / 48) * 0.05
  return (
    <AbsoluteFill>
      <AbsoluteFill
        style={{
          opacity: p,
          background: `linear-gradient(180deg, transparent 40%, rgba(46, 16, 32, ${0.8 * p}) 84%, rgba(74, 29, 49, ${p}) 104%)`,
        }}
      />
      <Moon opacity={p} />
      <div style={{ position: 'absolute', inset: 0, opacity: p }}>
        <div
          style={{
            position: 'absolute',
            left: -300,
            width: 1680,
            top: 900,
            height: 1020,
            background:
              'radial-gradient(58% 62% at 50% 100%, rgba(109, 43, 66, 0.6) 0%, rgba(109, 43, 66, 0.18) 55%, transparent 78%)',
          }}
        />
        <div
          style={{
            position: 'absolute',
            left: -200 + shimmer * 900,
            width: 1500,
            top: 1420,
            height: 260,
            opacity: 0.4,
            mixBlendMode: 'screen',
            filter: 'blur(40px)',
            background:
              'radial-gradient(50% 50% at 50% 50%, rgba(216, 132, 162, 0.16) 0%, transparent 70%)',
          }}
        />
        <div
          style={{
            position: 'absolute',
            left: -100 - shimmer * 900,
            width: 1400,
            top: 1660,
            height: 240,
            opacity: 0.35,
            mixBlendMode: 'screen',
            filter: 'blur(46px)',
            background:
              'radial-gradient(50% 50% at 50% 50%, rgba(241, 206, 223, 0.14) 0%, transparent 70%)',
          }}
        />
      </div>
    </AbsoluteFill>
  )
}


const LaunchLine: React.FC<{ from: number; size: number; y: number; weight: number; children: React.ReactNode; color?: string }> = ({
  from,
  size,
  y,
  weight,
  children,
  color = COLORS.warmWhite,
}) => {
  const frame = useCurrentFrame()
  if (frame < from) {
    return null
  }
  const p = interpolate(frame, [from, from + 34], [0, 1], {
    easing: Easing.bezier(0.16, 1, 0.3, 1),
    ...CLAMP,
  })
  return (
    <div
      style={{
        position: 'absolute',
        top: y,
        width: '100%',
        textAlign: 'center',
        fontFamily: launch,
        fontWeight: weight,
        fontSize: size,
        letterSpacing: `${lerp(0.16, 0.01, p)}em`,
        color,
        opacity: p,
        filter: `blur(${(1 - p) * 10}px)`,
      }}
    >
      {children}
    </div>
  )
}

const ReelFade: React.FC = () => {
  const frame = useCurrentFrame()
  const opacity = interpolate(frame, [R.fade, R.total - 2], [0, 1], CLAMP)
  if (opacity === 0) {
    return null
  }
  return <AbsoluteFill style={{ backgroundColor: COLORS.night, opacity }} />
}

export const Reel: React.FC = () => {
  const frame = useCurrentFrame()
  const wordP = interpolate(frame, [R.word + 60, R.word + 88], [-1, 2], CLAMP)
  return (
    <AbsoluteFill style={{ backgroundColor: COLORS.night }}>
      <World />
      <NightWorld />
      <DarkPetals count={8} dim={0.65} />
      <AssembleMark />
      <PullPetals />
      <SnapImpact />
      {frame >= R.word - 6 ? (
        <div
          style={{
            position: 'absolute',
            left: 540,
            top: 880,
            transform: 'translate(-50%, -50%)',
          }}
        >
          <div style={{ position: 'relative', overflow: 'hidden', paddingBottom: 6 }}>
            <Wordmark start={R.word} width={880} />
            {wordP > -1 && wordP < 2 ? (
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  mixBlendMode: 'screen',
                  background: `linear-gradient(105deg, transparent ${wordP * 60 - 18}%, rgba(255, 240, 245, 0.4) ${wordP * 60}%, transparent ${wordP * 60 + 18}%)`,
                }}
              />
            ) : null}
          </div>
        </div>
      ) : null}
      <LaunchLine from={R.tagline} size={46} weight={600} y={1120}>
        Don’t just code for the vibes.
      </LaunchLine>
      <LaunchLine from={R.url} size={54} weight={700} y={1250} color={COLORS.white}>
        code2create.in
      </LaunchLine>
      <LaunchLine from={R.url + 14} size={26} weight={500} y={1330} color="#B9A3AC">
        VIT Vellore
      </LaunchLine>
      <Sequence from={R.snap - 8} durationInFrames={40} premountFor={30}>
        <Audio src={staticFile('sfx/whoosh.wav')} volume={0.35} />
      </Sequence>
      <Grain />
      <Vignette strength={0.38} />
      <ReelFade />
    </AbsoluteFill>
  )
}

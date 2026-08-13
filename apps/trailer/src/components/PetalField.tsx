import { AbsoluteFill, Img, interpolate, random, staticFile, useCurrentFrame, useVideoConfig } from 'remotion'
import { noise3D } from '@remotion/noise'

export type PetalLayer = {
  count: number
  blur: number
  sizeMin: number
  sizeMax: number
  opacity: number
  speed: number
}

const Petal: React.FC<{ id: string; layer: PetalLayer; speedMul: number }> = ({
  id,
  layer,
  speedMul,
}) => {
  const frame = useCurrentFrame()
  const { width, height } = useVideoConfig()
  const speed = speedMul * layer.speed
  const size = interpolate(random(`sz${id}`), [0, 1], [layer.sizeMin, layer.sizeMax])
  const fallDur = (300 + random(`fd${id}`) * 220) / layer.speed
  const t = ((frame * speedMul + random(`ph${id}`) * fallDur) % fallDur) / fallDur
  const y = t * (height + 340) - 170
  const x0 = interpolate(random(`x${id}`), [0, 1], [-0.08, 1.08]) * width
  const sway = noise3D(`sw${id}`, 0, 0, frame / 95) * 120
  const flutter = noise3D(`fl${id}`, 0, 0, frame / 20) * 14
  const dir = random(`rd${id}`) > 0.5 ? 1 : -1
  const spin = random(`r0${id}`) * 360 + frame * speed * (0.4 + random(`rs${id}`) * 1.1) * dir
  const tumble = noise3D(`tb${id}`, 0, 0, frame / 42) * 58
  const twist = noise3D(`tw${id}`, 0, 0, frame / 55) * 48
  const flip = random(`fp${id}`) > 0.5 ? -1 : 1
  const brightness = 0.94 + random(`br${id}`) * 0.14
  return (
    <Img
      src={staticFile('petal.png')}
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        width: size,
        opacity: layer.opacity,
        filter: `brightness(${brightness})`,
        transform: `translate(${x0 + sway + flutter}px, ${y}px) rotate(${spin}deg) rotateX(${tumble}deg) rotateY(${twist}deg) scaleX(${flip})`,
      }}
    />
  )
}

export const PetalField: React.FC<{
  seed: string
  layers: PetalLayer[]
  speedMul?: number
}> = ({ seed, layers, speedMul = 1 }) => {
  return (
    <>
      {layers.map((layer, li) => (
        <AbsoluteFill
          key={li}
          style={layer.blur > 0 ? { filter: `blur(${layer.blur}px)` } : {}}
        >
          {Array.from({ length: layer.count }, (_, i) => (
            <Petal key={i} id={`${seed}${li}-${i}`} layer={layer} speedMul={speedMul} />
          ))}
        </AbsoluteFill>
      ))}
    </>
  )
}

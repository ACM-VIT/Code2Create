import { AbsoluteFill, Sequence, staticFile } from 'remotion'
import { Audio } from '@remotion/media'
import { ActOne } from './scenes/ActOne.tsx'
import { NightHero } from './scenes/NightHero.tsx'
import { FadeOut, Grain, Vignette, Wash } from './components/Grade.tsx'
import { COLORS, T } from './theme.ts'

export const Trailer: React.FC = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: COLORS.night }}>
      <Sequence durationInFrames={T.washPeak} premountFor={30}>
        <ActOne />
      </Sequence>
      <Sequence from={T.actB} premountFor={30}>
        <NightHero />
      </Sequence>
      <Sequence from={T.whoosh} durationInFrames={40} premountFor={30}>
        <Audio src={staticFile('sfx/whoosh.wav')} volume={0.4} />
      </Sequence>
      <Wash />
      <Grain />
      <Vignette />
      <FadeOut />
    </AbsoluteFill>
  )
}

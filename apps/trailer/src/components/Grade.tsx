import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { COLORS, T, CLAMP } from "../theme.ts";

export const Grain: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ opacity: 0.055, mixBlendMode: "overlay", pointerEvents: "none" }}>
      <svg width="100%" height="100%">
        <filter id="grain">
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.9"
            numOctaves="2"
            seed={Math.floor(frame / 2) % 40}
            stitchTiles="stitch"
          />
          <feColorMatrix type="saturate" values="0" />
        </filter>
        <rect width="100%" height="100%" filter="url(#grain)" />
      </svg>
    </AbsoluteFill>
  );
};

export const Vignette: React.FC<{ strength?: number }> = ({ strength = 0.42 }) => (
  <AbsoluteFill
    style={{
      pointerEvents: "none",
      background: `radial-gradient(125% 95% at 50% 45%, transparent 56%, rgba(26, 8, 18, ${strength}) 100%)`,
    }}
  />
);

export const Wash: React.FC = () => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [T.washStart, T.washPeak, T.washEnd], [0, 1, 0], CLAMP);
  if (opacity === 0) {
    return null;
  }
  return <AbsoluteFill style={{ backgroundColor: COLORS.wash, opacity }} />;
};

export const FadeOut: React.FC = () => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [T.fadeOutStart, T.total - 2], [0, 1], CLAMP);
  if (opacity === 0) {
    return null;
  }
  return <AbsoluteFill style={{ backgroundColor: COLORS.night, opacity }} />;
};

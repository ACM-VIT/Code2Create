import {
  AbsoluteFill,
  Easing,
  Img,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { noise3D } from "@remotion/noise";
import { PetalField, type PetalLayer } from "../components/PetalField.tsx";
import { LogoMark } from "../components/LogoMark.tsx";
import { Wordmark } from "../components/Wordmark.tsx";
import { COLORS, CLAMP } from "../theme.ts";
import { sans, serif } from "../fonts.ts";

const LAYERS: PetalLayer[] = [
  { count: 8, blur: 2, sizeMin: 22, sizeMax: 44, opacity: 0.45, speed: 0.5 },
  { count: 8, blur: 0, sizeMin: 55, sizeMax: 100, opacity: 0.8, speed: 1 },
  { count: 3, blur: 6, sizeMin: 200, sizeMax: 340, opacity: 0.65, speed: 1.6 },
];

// Frame values are relative to this scene.
const LOGO_IN = 10;
const WORD_IN = 24;
const KICKER_IN = 96;
const SHIFT = 150;
const LINES_IN = 158;

const LANTERNS = [
  { x: 0.63, y: 0.3, size: 62, drift: 24 },
  { x: 0.72, y: 0.13, size: 44, drift: 31 },
  { x: 0.815, y: 0.34, size: 84, drift: 18 },
  { x: 0.885, y: 0.18, size: 36, drift: 40 },
];

const Lanterns: React.FC = () => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  return (
    <>
      {LANTERNS.map((l, i) => {
        const rise = frame * (0.045 + i * 0.012);
        const sway = noise3D(`lan${i}`, 0, 0, frame / 80) * l.drift;
        const flicker = 0.78 + noise3D(`fli${i}`, 0, 0, frame / 8) * 0.1;
        return (
          <Img
            key={i}
            src={staticFile("lantern.png")}
            style={{
              position: "absolute",
              left: l.x * width,
              top: l.y * height,
              width: l.size,
              opacity: flicker,
              filter: "drop-shadow(0 0 22px rgba(240, 138, 46, 0.5))",
              transform: `translate(${sway}px, ${-rise}px)`,
            }}
          />
        );
      })}
    </>
  );
};

const EndLine: React.FC<{
  i: number;
  children: React.ReactNode;
  style: React.CSSProperties;
}> = ({ i, children, style }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const raw = spring({ frame, fps, delay: LINES_IN + i * 10, config: { damping: 200 } });
  const p = interpolate(raw, [0, 0.95], [0, 1], CLAMP);
  return (
    <div
      style={{
        ...style,
        opacity: p,
        transform: `translateY(${interpolate(p, [0, 1], [30, 0])}px)`,
        filter: `blur(${interpolate(p, [0, 1], [8, 0])}px)`,
      }}
    >
      {children}
    </div>
  );
};

export const NightHero: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const settleRaw = spring({ frame, fps, config: { mass: 10, damping: 200 } });
  const settle = interpolate(settleRaw, [0, 0.95], [0, 1], CLAMP);
  const worldScale = interpolate(settle, [0, 1], [1.045, 1]);

  const treeSway = noise3D("tree", 0, 0, frame / 130) * 0.35;

  const shiftRaw = spring({ frame, fps, delay: SHIFT, config: { damping: 200, mass: 1.2 } });
  const shift = interpolate(shiftRaw, [0, 0.95], [0, 1], CLAMP);

  const kickerRaw = spring({ frame, fps, delay: KICKER_IN, config: { damping: 200 } });
  const kickerIn = interpolate(kickerRaw, [0, 0.95], [0, 1], CLAMP);
  const kickerOut = interpolate(frame, [SHIFT - 4, SHIFT + 10], [1, 0], {
    easing: Easing.in(Easing.cubic),
    ...CLAMP,
  });

  return (
    <AbsoluteFill style={{ backgroundColor: COLORS.night }}>
      <AbsoluteFill style={{ transform: `scale(${worldScale})`, transformOrigin: "42% 30%" }}>
        <AbsoluteFill
          style={{
            background: `linear-gradient(180deg, ${COLORS.night} 0%, ${COLORS.night} 58%, ${COLORS.plum} 108%)`,
          }}
        />
        <Lanterns />
        <Img
          src={staticFile("hills.png")}
          style={{
            position: "absolute",
            width: 2500,
            left: -290,
            bottom: -330,
            opacity: 0.92,
          }}
        />
        <Img
          src={staticFile("tree.png")}
          style={{
            position: "absolute",
            width: 1560,
            left: -190,
            top: -150,
            transform: `rotate(${treeSway}deg)`,
            transformOrigin: "15% 88%",
          }}
        />
        <PetalField seed="b" layers={LAYERS} speedMul={0.5} />
      </AbsoluteFill>

      <AbsoluteFill
        style={{
          alignItems: "center",
          justifyContent: "center",
          transform: `translateY(${interpolate(shift, [0, 1], [-16, -102])}px) scale(${interpolate(shift, [0, 1], [1, 0.93])})`,
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 56,
          }}
        >
          <LogoMark start={LOGO_IN} height={216} />
          <Wordmark start={WORD_IN} width={940} />
          <div
            style={{
              fontFamily: sans,
              fontWeight: 500,
              fontSize: 27,
              letterSpacing: "0.24em",
              color: COLORS.blossomMid,
              opacity: kickerIn * kickerOut * 0.9,
              transform: `translateY(${interpolate(kickerIn, [0, 1], [26, 0])}px)`,
              filter: `blur(${interpolate(kickerIn, [0, 1], [8, 0])}px)`,
              marginTop: 8,
            }}
          >
            THE LEGACY 48-HOUR NATIONAL HACKATHON
          </div>
        </div>
      </AbsoluteFill>

      <AbsoluteFill style={{ alignItems: "center", justifyContent: "flex-end" }}>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 26,
            marginBottom: 148,
          }}
        >
          <EndLine
            i={0}
            style={{
              fontFamily: serif,
              fontWeight: 400,
              fontSize: 46,
              color: COLORS.blossomLight,
            }}
          >
            Don’t just code for the vibes.
          </EndLine>
          <EndLine
            i={1}
            style={{
              fontFamily: sans,
              fontWeight: 500,
              fontSize: 23,
              letterSpacing: "0.2em",
              color: COLORS.blossomMid,
            }}
          >
            VIT VELLORE · 2026 · REGISTRATIONS NOW LIVE
          </EndLine>
          <EndLine
            i={2}
            style={{
              fontFamily: sans,
              fontWeight: 600,
              fontSize: 33,
              color: COLORS.white,
            }}
          >
            c2c.acmvit.in
          </EndLine>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

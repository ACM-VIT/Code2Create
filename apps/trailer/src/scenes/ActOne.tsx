import {
  AbsoluteFill,
  Easing,
  Img,
  interpolate,
  random,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { CameraMotionBlur } from "@remotion/motion-blur";
import { noise3D } from "@remotion/noise";
import { PetalField } from "../components/PetalField.tsx";
import type { PetalLayer } from "../components/PetalField.tsx";
import { COLORS, T, CLAMP } from "../theme.ts";
import { sans, serif } from "../fonts.ts";

const NightSky: React.FC<{ glow?: number }> = ({ glow = 0.5 }) => (
  <AbsoluteFill style={{ backgroundColor: COLORS.night }}>
    <AbsoluteFill
      style={{
        opacity: glow,
        background: `radial-gradient(140% 90% at 50% 112%, rgba(109, 43, 66, 0.7) 0%, rgba(109, 43, 66, 0.22) 48%, transparent 74%)`,
      }}
    />
  </AbsoluteFill>
);

const ShotCanopy: React.FC = () => {
  const frame = useCurrentFrame();
  if (frame > 142) {
    return null;
  }
  const drift = interpolate(frame, [0, 140], [0, -44], CLAMP);
  const breathe = interpolate(frame, [0, 140], [1.06, 1], {
    easing: Easing.bezier(0.45, 0, 0.55, 1),
    ...CLAMP,
  });
  const sway = noise3D("bower", 0, 0, frame / 120) * 0.4;
  const layers: PetalLayer[] = [
    { count: 7, blur: 0, sizeMin: 70, sizeMax: 150, opacity: 0.95, speed: 1 },
    { count: 4, blur: 7, sizeMin: 260, sizeMax: 420, opacity: 0.75, speed: 1.6 },
  ];
  return (
    <AbsoluteFill>
      <NightSky glow={0.35} />
      <Img
        src={staticFile("tree.png")}
        style={{
          position: "absolute",
          width: 2700,
          top: -760,
          left: -120,
          opacity: 0.8,
          filter: "blur(3.5px) brightness(0.72) saturate(0.92)",
          transform: `scaleX(-1) translateX(${-drift * 0.4}px) scale(${breathe})`,
        }}
      />
      <AbsoluteFill
        style={{
          mixBlendMode: "screen",
          background:
            "radial-gradient(60% 55% at 78% 6%, rgba(255, 246, 241, 0.16) 0%, rgba(241, 206, 223, 0.07) 45%, transparent 72%)",
        }}
      />
      <Img
        src={staticFile("tree.png")}
        style={{
          position: "absolute",
          width: 3200,
          top: -500,
          left: -1420,
          filter: "blur(0.8px) saturate(1.06) contrast(1.03)",
          transform: `translateX(${drift}px) scale(${breathe}) rotate(${sway}deg)`,
          transformOrigin: "30% 10%",
        }}
      />
      <PetalField seed="bower" layers={layers} speedMul={0.85} />
    </AbsoluteFill>
  );
};

const LANTERN_SHOT = [
  { x: 1310, y0: 880, y1: 210, size: 430, sway: 26, blur: 0, glow: 0.55 },
  { x: 430, y0: 520, y1: 240, size: 150, sway: 38, blur: 2, glow: 0.4 },
  { x: 1710, y0: 420, y1: 200, size: 90, sway: 30, blur: 3, glow: 0.35 },
  { x: 250, y0: 260, y1: 140, size: 52, sway: 22, blur: 3.5, glow: 0.3 },
];

const ShotLanterns: React.FC = () => {
  const frame = useCurrentFrame();
  if (frame < T.shot2 - 6 || frame > T.shot3 + 14) {
    return null;
  }
  const local = frame - T.shot2;
  const fadeIn = interpolate(frame, [T.shot2, T.shot2 + 12], [0, 1], CLAMP);
  const rise = interpolate(local, [0, 172], [0, 1], {
    easing: Easing.bezier(0.45, 0, 0.55, 1),
    ...CLAMP,
  });
  const layers: PetalLayer[] = [
    { count: 6, blur: 1.5, sizeMin: 30, sizeMax: 60, opacity: 0.5, speed: 0.6 },
    { count: 6, blur: 0, sizeMin: 60, sizeMax: 110, opacity: 0.85, speed: 1 },
    { count: 2, blur: 7, sizeMin: 260, sizeMax: 380, opacity: 0.7, speed: 1.6 },
  ];
  return (
    <AbsoluteFill style={{ opacity: fadeIn }}>
      <NightSky glow={0.55} />
      <Img
        src={staticFile("hills.png")}
        style={{
          position: "absolute",
          width: 2200,
          left: -140,
          bottom: -560,
          opacity: 0.5,
          filter: "blur(3px) brightness(0.7)",
        }}
      />
      {LANTERN_SHOT.map((l, i) => {
        const y = interpolate(rise, [0, 1], [l.y0, l.y1]);
        const sway = noise3D(`ls${i}`, 0, 0, frame / 85) * l.sway;
        const flicker = 0.86 + noise3D(`lf${i}`, 0, 0, frame / 7) * 0.09;
        const tilt = noise3D(`lt${i}`, 0, 0, frame / 70) * 4;
        return (
          <div key={i}>
            <div
              style={{
                position: "absolute",
                left: l.x - l.size * 1.4,
                top: y - l.size * 1.1,
                width: l.size * 2.9,
                height: l.size * 2.9,
                opacity: l.glow * flicker,
                mixBlendMode: "screen",
                background:
                  "radial-gradient(50% 50% at 50% 50%, rgba(240, 138, 46, 0.5) 0%, rgba(240, 138, 46, 0.14) 48%, transparent 72%)",
                transform: `translate(${sway}px, 0px)`,
              }}
            />
            <Img
              src={staticFile("lantern.png")}
              style={{
                position: "absolute",
                left: l.x,
                top: y,
                width: l.size,
                opacity: flicker,
                filter:
                  l.blur > 0
                    ? `blur(${l.blur}px) brightness(${flicker})`
                    : `brightness(${flicker})`,
                transform: `translate(${sway}px, 0px) rotate(${tilt}deg)`,
              }}
            />
          </div>
        );
      })}
      <PetalField seed="sky" layers={layers} speedMul={0.7} />
    </AbsoluteFill>
  );
};

const LANDINGS = [
  { at: 318, x: 760, y: 812, size: 118 },
  { at: 354, x: 1150, y: 838, size: 96 },
  { at: 390, x: 950, y: 820, size: 106 },
];

const Ripple: React.FC<{ at: number; x: number; y: number; delay: number }> = ({
  at,
  x,
  y,
  delay,
}) => {
  const frame = useCurrentFrame();
  const p = interpolate(frame, [at + delay, at + delay + 46], [0, 1], {
    easing: Easing.out(Easing.cubic),
    ...CLAMP,
  });
  if (p === 0 || p === 1) {
    return null;
  }
  const w = interpolate(p, [0, 1], [24, 300]);
  return (
    <div
      style={{
        position: "absolute",
        left: x - w / 2,
        top: y - (w * 0.3) / 2,
        width: w,
        height: w * 0.3,
        borderRadius: "50%",
        border: "2px solid rgba(241, 206, 223, 0.4)",
        opacity: interpolate(p, [0, 0.15, 1], [0, 0.55, 0], CLAMP),
      }}
    />
  );
};

const LandingPetal: React.FC<{ at: number; x: number; y: number; size: number; i: number }> = ({
  at,
  x,
  y,
  size,
  i,
}) => {
  const frame = useCurrentFrame();
  const fall = interpolate(frame, [at - 64, at], [0, 1], {
    easing: Easing.out(Easing.cubic),
    ...CLAMP,
  });
  if (fall === 0) {
    return null;
  }
  const py = interpolate(fall, [0, 1], [y - 620, y]);
  const px = x + Math.sin((frame - at) / 30 + i) * (fall < 1 ? 40 * (1 - fall) : 0);
  const afterDrift = frame > at ? (frame - at) * 0.25 : 0;
  const bob = frame > at ? Math.sin((frame - at) / 14) * 2.5 : 0;
  const flatten = interpolate(fall, [0, 1], [30, 72]);
  return (
    <Img
      src={staticFile("petal.png")}
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width: size,
        opacity: 0.95,
        transform: `translate(${px + afterDrift}px, ${py + bob}px) rotateX(${flatten}deg) rotate(${18 + i * 40}deg)`,
      }}
    />
  );
};

const ShotWater: React.FC = () => {
  const frame = useCurrentFrame();
  if (frame < T.shot3 - 6) {
    return null;
  }
  const fadeIn = interpolate(frame, [T.shot3, T.shot3 + 12], [0, 1], CLAMP);
  const settle = interpolate(frame, [T.shot3, T.diveStart], [1.05, 1], {
    easing: Easing.bezier(0.45, 0, 0.55, 1),
    ...CLAMP,
  });
  const lift = interpolate(frame, [T.diveStart, T.washPeak], [0, 1], {
    easing: Easing.in(Easing.cubic),
    ...CLAMP,
  });
  const scale = settle + lift * 1.15;
  const shimmer = noise3D("shimmer", 0, 0, frame / 50) * 0.04;
  const layers: PetalLayer[] = [
    { count: 8, blur: 0, sizeMin: 45, sizeMax: 95, opacity: 0.85, speed: 1 },
    { count: 3, blur: 7, sizeMin: 240, sizeMax: 360, opacity: 0.65, speed: 1.7 },
  ];

  const world = (
    <AbsoluteFill
      style={{
        transform: `scale(${scale}) translateY(${lift * 190}px)`,
        transformOrigin: "50% 26%",
      }}
    >
      <NightSky glow={0.75} />
      {[
        { x: 1230, y: 585, size: 44 },
        { x: 1585, y: 630, size: 28 },
      ].map((l, i) => (
        <Img
          key={i}
          src={staticFile("lantern.png")}
          style={{
            position: "absolute",
            left: l.x,
            top: l.y - frame * 0.06,
            width: l.size,
            opacity: 0.55 + noise3D(`fw${i}`, 0, 0, frame / 9) * 0.1,
            filter: "drop-shadow(0 0 14px rgba(240, 138, 46, 0.5))",
          }}
        />
      ))}
      <Img
        src={staticFile("hills.png")}
        style={{
          position: "absolute",
          width: 2800,
          left: -440,
          bottom: -420,
          filter: "saturate(1.05)",
        }}
      />
      <AbsoluteFill
        style={{
          mixBlendMode: "screen",
          opacity: 0.5 + shimmer,
          background:
            "linear-gradient(180deg, transparent 56%, rgba(216, 132, 162, 0.11) 64%, rgba(216, 132, 162, 0.04) 76%, rgba(216, 132, 162, 0.13) 90%, transparent 100%)",
        }}
      />
      {LANDINGS.map((l, i) => (
        <LandingPetal key={i} at={l.at} x={l.x} y={l.y} size={l.size} i={i} />
      ))}
      {LANDINGS.map((l, i) => (
        <div key={i}>
          <Ripple at={l.at} x={l.x + l.size / 2} y={l.y + l.size * 0.42} delay={0} />
          <Ripple at={l.at} x={l.x + l.size / 2} y={l.y + l.size * 0.42} delay={12} />
        </div>
      ))}
      <PetalField seed="water" layers={layers} speedMul={0.7} />
    </AbsoluteFill>
  );

  return (
    <AbsoluteFill style={{ opacity: fadeIn }}>
      {frame >= T.diveStart - 10 ? (
        <CameraMotionBlur shutterAngle={200} samples={5}>
          {world}
        </CameraMotionBlur>
      ) : (
        world
      )}
    </AbsoluteFill>
  );
};

const Kicker: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const raw = spring({ frame, fps, delay: T.kickerIn, config: { damping: 200 } });
  const enter = interpolate(raw, [0, 0.95], [0, 1], CLAMP);
  const exit = interpolate(frame, [T.kickerOut - 16, T.kickerOut], [1, 0], {
    easing: Easing.in(Easing.cubic),
    ...CLAMP,
  });
  return (
    <AbsoluteFill>
      <div
        style={{
          position: "absolute",
          top: "69%",
          width: "100%",
          textAlign: "center",
          fontFamily: sans,
          fontWeight: 500,
          fontSize: 30,
          letterSpacing: "0.26em",
          color: COLORS.blossomMid,
          opacity: enter * exit * 0.92,
          transform: `translateY(${interpolate(enter, [0, 1], [34, 0])}px)`,
          filter: `blur(${interpolate(enter, [0, 1], [10, 0])}px)`,
        }}
      >
        ACM-VIT PRESENTS
      </div>
    </AbsoluteFill>
  );
};

const Line: React.FC<{ text: string; from: number; to: number; offsetX?: number; y?: string }> = ({
  text,
  from,
  to,
  offsetX = 0,
  y = "44%",
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const raw = spring({ frame, fps, delay: from, config: { damping: 200, mass: 1.4 } });
  const enter = interpolate(raw, [0, 0.95], [0, 1], CLAMP);
  const exit = interpolate(frame, [to - 18, to], [1, 0], {
    easing: Easing.in(Easing.cubic),
    ...CLAMP,
  });
  if (frame < from || exit === 0) {
    return null;
  }
  return (
    <AbsoluteFill>
      <div
        style={{
          position: "absolute",
          top: y,
          width: "100%",
          textAlign: "center",
          fontFamily: serif,
          fontWeight: 500,
          fontSize: 138,
          color: COLORS.warmWhite,
          letterSpacing: "-0.01em",
          textShadow: "0 0 70px rgba(216, 132, 162, 0.3)",
          opacity: enter * exit,
          transform: `translateX(${offsetX}px) translateY(${interpolate(enter, [0, 1], [50, 0])}px) scale(${interpolate(enter, [0, 1], [0.97, 1])})`,
          filter: `blur(${interpolate(enter, [0, 1], [14, 0]) + (1 - exit) * 8}px)`,
        }}
      >
        {text}
      </div>
    </AbsoluteFill>
  );
};

const DiveBurst: React.FC = () => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  if (frame < T.diveStart || frame > T.washPeak + 4) {
    return null;
  }
  const cx = width * 0.5;
  const cy = height * 0.3;
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      {Array.from({ length: 26 }, (_, i) => {
        const start = T.diveStart - 6 + (i / 26) * 62 + random(`ds${i}`) * 6;
        const life = 18 + random(`dl${i}`) * 10;
        const p = (frame - start) / life;
        if (p <= 0 || p >= 1) {
          return null;
        }
        const grow = p ** 1.6;
        const angle = random(`da${i}`) * Math.PI * 2;
        const dist = interpolate(
          grow,
          [0, 1],
          [70 + random(`d0${i}`) * 150, 1500 + random(`d1${i}`) * 600],
        );
        const x = cx + Math.cos(angle) * dist;
        const y = cy + Math.sin(angle) * dist * 0.75;
        const size = 58 + grow * (560 + random(`dz${i}`) * 400);
        const angleDeg = (angle * 180) / Math.PI + random(`dw${i}`) * 24 - 12;
        const streak = 1 + p * 1.6;
        const opacity = interpolate(p, [0, 0.15, 0.8, 1], [0, 0.92, 0.85, 0], CLAMP);
        return (
          <Img
            key={i}
            src={staticFile("petal.png")}
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              width: size,
              opacity,
              filter: `blur(${4 + p * 10}px)`,
              transform: `translate(${x - size / 2}px, ${y - size / 2}px) rotate(${angleDeg}deg) scaleX(${streak})`,
            }}
          />
        );
      })}
    </AbsoluteFill>
  );
};

const LensPetals: React.FC = () => {
  const frame = useCurrentFrame();
  const p = interpolate(frame, [438, T.washPeak], [0, 1], {
    easing: Easing.in(Easing.quad),
    ...CLAMP,
  });
  if (p === 0) {
    return null;
  }
  return (
    <AbsoluteFill style={{ filter: "blur(18px)" }}>
      <Img
        src={staticFile("petal-hero.png")}
        style={{
          position: "absolute",
          width: 2600,
          opacity: interpolate(p, [0, 0.4], [0, 0.95], CLAMP),
          transform: `translate(${interpolate(p, [0, 1], [1500, -900])}px, ${interpolate(p, [0, 1], [900, -700])}px) rotate(${interpolate(p, [0, 1], [38, -6])}deg)`,
        }}
      />
      <Img
        src={staticFile("petal-hero.png")}
        style={{
          position: "absolute",
          width: 2200,
          opacity: interpolate(p, [0.2, 0.55], [0, 0.9], CLAMP),
          transform: `translate(${interpolate(p, [0, 1], [-1800, 600])}px, ${interpolate(p, [0, 1], [1200, -500])}px) rotate(${interpolate(p, [0, 1], [-30, 14])}deg)`,
        }}
      />
    </AbsoluteFill>
  );
};

export const ActOne: React.FC = () => (
  <AbsoluteFill style={{ backgroundColor: COLORS.night }}>
    <ShotCanopy />
    <ShotLanterns />
    <ShotWater />
    <Kicker />
    <Line text="“what if?”" from={T.lineAIn} to={T.lineAOut} offsetX={-150} />
    <Line text="“it works.”" from={T.lineBIn} to={T.lineBOut} y="38%" />
    <DiveBurst />
    <LensPetals />
  </AbsoluteFill>
);

/*
 * The great blossom behind the timeline card.
 *
 * Drawn to the botany, not to a flower icon: sakura petals are obovate —
 * widest ABOVE the middle, narrowing to a short claw at the base — with the
 * emarginate V notch cut into the broad tip. The body is nearly white, the
 * rose flush held tight to the claw; fine striations fan from the base; the
 * dark red calyx shows as sepal points between the claws; and the heart is
 * a ring of pale filaments tipped with pale-yellow anthers. Two petal
 * variants and a hair of tilt per petal keep it grown rather than drafted,
 * and a dark back whorl fills the gaps for depth.
 *
 * The timeline reveals the front petals one at a time as the act scrubs by
 * and turns the whole head slowly; everything here is a static SVG on its
 * own compositor layer, so the turn is a transform and costs the frame
 * nothing. No SVG filters — this act's frame budget was hard won.
 *
 * Purely ornamental: it sits below the day card and the bonsai, is absent
 * on phones, and the timeline fades it out before the days leave, so the
 * FAQ act still opens on a bare stage.
 */

/* Obovate with a claw, pointing up; the two L segments cut the V notch. */
const PETAL_A =
  'M 0 -6 C -6 -7 -9 -12 -10 -20 C -12 -38 -30 -48 -38 -64 C -44 -76 -45 -92 -36 -100 C -30 -105.5 -22 -107 -15 -104 L 0 -88 L 15 -104 C 22 -107 30 -105.5 36 -100 C 45 -92 44 -76 38 -64 C 30 -48 12 -38 10 -20 C 9 -12 6 -7 0 -6 Z';
const PETAL_B =
  'M 0 -6 C -6 -7 -10 -13 -11 -21 C -14 -40 -31 -50 -39 -65 C -45 -78 -44 -93 -34 -101 C -28 -105.5 -21 -106.5 -14 -103.5 L 0 -87 L 14 -103.5 C 21 -106.5 28 -105.5 34 -101 C 44 -93 45 -78 39 -65 C 31 -50 14 -40 11 -21 C 10 -13 6 -7 0 -6 Z';

/* Seven striations fanning from the claw, as one path. */
const STRIATIONS =
  'M 0 -22 C -1 -48 -0.5 -72 0 -92 M -3.5 -23 C -5.5 -50 -6.5 -72 -7 -90 M 3.5 -23 C 5.5 -50 6.5 -72 7 -90 M -7 -24 C -11 -46 -14 -66 -15 -84 M 7 -24 C 11 -46 14 -66 15 -84 M -14 -28 C -20 -46 -25 -60 -27 -74 M 14 -28 C 20 -46 25 -60 27 -74';

/* A sepal point of the calyx, peeking between two claws. */
const SEPAL =
  'M -4.2 -8 C -2.5 -14 -1 -19 0 -23 C 1 -19 2.5 -14 4.2 -8 C 1.6 -5.5 -1.6 -5.5 -4.2 -8 Z';

/* A hair of tilt per petal, so the flower is grown rather than drafted. */
const TILT = [-2, 1.6, -1.2, 2.2, -1.5];

/* The stamen ring: deterministic jitter, so renders never disagree. */
const STAMENS = Array.from({ length: 20 }, (_, i) => {
  const angle = i * (360 / 20) + (((i * 53) % 9) - 4);
  const length = 26 + ((i * 29) % 11);
  const theta = (angle * Math.PI) / 180;
  const sx = Math.sin(theta);
  const sy = -Math.cos(theta);
  const bend = (((i * 17) % 7) - 3) * 0.55;
  const mx = ((sx * 5 + sx * length) / 2 - sy * bend).toFixed(1);
  const my = ((sy * 5 + sy * length) / 2 + sx * bend).toFixed(1);
  return {
    d: `M ${(sx * 5).toFixed(1)} ${(sy * 5).toFixed(1)} Q ${mx} ${my} ${(sx * length).toFixed(1)} ${(sy * length).toFixed(1)}`,
    tx: +(sx * length).toFixed(1),
    ty: +(sy * length).toFixed(1),
  };
});

const PETALS = [0, 1, 2, 3, 4];

export default function Rosette() {
  return (
    <div className="rosette" aria-hidden="true">
      <svg viewBox="-120 -120 240 240">
        <defs>
          {/* Nearly white body, the flush held tight to the claw — shared in
              user space so all five petals shade from the same centre. */}
          <radialGradient id="rosetteFlush" gradientUnits="userSpaceOnUse" cx="0" cy="-2" r="108">
            <stop offset="0" stopColor="#b44f78" />
            <stop offset="0.14" stopColor="#dc8aa8" />
            <stop offset="0.3" stopColor="#f3c8d7" />
            <stop offset="0.55" stopColor="#fbe7ee" />
            <stop offset="0.8" stopColor="#fef6f9" />
            <stop offset="1" stopColor="#fffdfe" />
          </radialGradient>
          {/* A whisper of extra light at the emarginate tip. */}
          <linearGradient id="rosetteTipGlow" gradientUnits="userSpaceOnUse" x1="0" y1="-34" x2="0" y2="-106">
            <stop offset="0" stopColor="#ffffff" stopOpacity="0" />
            <stop offset="0.7" stopColor="#ffffff" stopOpacity="0.18" />
            <stop offset="1" stopColor="#ffffff" stopOpacity="0.34" />
          </linearGradient>
          {/* The back whorl, showing through the gaps between petals. Fully
              opaque out to its own silhouette — a fade here would erase the
              lobes, which are the only part the gaps ever reveal. */}
          <radialGradient id="rosetteBackTint" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="100">
            <stop offset="0" stopColor="#7c2b52" />
            <stop offset="0.65" stopColor="#5e2140" />
            <stop offset="1" stopColor="#47182f" />
          </radialGradient>
        </defs>

        {/* Depth: a darker whorl turned half a step, filling the gaps. */}
        <g className="rosette__back">
          {PETALS.map((index) => (
            <g key={index} transform={`rotate(${index * 72 + 36}) scale(0.94)`}>
              <path d={index % 2 ? PETAL_B : PETAL_A} />
            </g>
          ))}
        </g>

        {/* The calyx: sepal points between the petal claws. */}
        <g className="rosette__calyx">
          {PETALS.map((index) => (
            <path
              className="rosette__sepal"
              transform={`rotate(${index * 72 + 36})`}
              d={SEPAL}
              key={index}
            />
          ))}
        </g>

        <g className="rosette__petals">
          {PETALS.map((index) => (
            <g key={index} transform={`rotate(${index * 72 + TILT[index]})`}>
              {/* The group is what the timeline reveals, so the detail can
                  never show before its own petal does. */}
              <g className="rosette__petal">
                <path
                  className="rosette__petal-shape"
                  d={index % 2 ? PETAL_B : PETAL_A}
                />
                <path className="rosette__glow" d={index % 2 ? PETAL_B : PETAL_A} />
                <path className="rosette__vein" d={STRIATIONS} />
              </g>
            </g>
          ))}
        </g>

        {/* The heart: calyx disc, pale filaments, pale-yellow anthers. */}
        <circle className="rosette__disc" r="5" />
        {STAMENS.map((stamen) => (
          <path className="rosette__stamen" d={stamen.d} key={stamen.d} />
        ))}
        {STAMENS.map((stamen) => (
          <circle
            className="rosette__anther"
            cx={stamen.tx}
            cy={stamen.ty}
            r="1.5"
            key={`a${stamen.d}`}
          />
        ))}
        <circle className="rosette__pistil" r="1.9" />
      </svg>
    </div>
  );
}

/*
 * The emblem and the five cards it becomes.
 *
 * The C2C mark is a hexagon built from exactly five coloured triangles
 * (logo.svg → Vector_3 … Vector_7). Each card starts life clipped to one of
 * those triangles, in that triangle's own colour, laid exactly over the logo —
 * so the transformation begins from the real mark rather than an impression of
 * it. Then each wedge unfolds into a card and flies down to the fan.
 */

/* The logo's own drawing box, from its clipPath. */
export const LOGO_BOX = { w: 150, h: 163.825 };

/*
 * A card is taller than the emblem for the same width, so when a card is laid
 * over the logo the emblem only fills a horizontal band down its middle. These
 * are that band's height and top offset, as fractions of the card — the wedge
 * polygons are mapped through them so they land on the mark exactly.
 */
/* The box follows the supplied deck's own proportions (the scans ship at
   560×862, cropped at their gold hairline), so the faces fill it with no
   felt beyond the border and under 2% stretch. */
const CARD_ASPECT = 862 / 560;
const LOGO_ASPECT = LOGO_BOX.h / LOGO_BOX.w;
export const LOGO_BAND = {
  scale: LOGO_ASPECT / CARD_ASPECT,
  get offset() {
    return (1 - this.scale) / 2;
  },
};

type Point = readonly [number, number];
type Triangle = readonly [Point, Point, Point];

interface Wedge {
  fill: string
  points: Triangle
}

const pct = ([x, y]: Point) => {
  const px = (x / LOGO_BOX.w) * 100;
  const py = (LOGO_BAND.offset + (y / LOGO_BOX.h) * LOGO_BAND.scale) * 100;
  return `${px.toFixed(3)}% ${py.toFixed(3)}%`;
};

/* Triangles lifted verbatim from the logo's path data. */
const WEDGES: readonly Wedge[] = [
  { fill: '#F1CEDF', points: [[121.682, 55.793], [75.076, 81.919], [75.076, 29.721]] },
  { fill: '#D884A2', points: [[75.076, 29.748], [28.568, 55.807], [75.076, 81.892]] },
  { fill: '#B44F76', points: [[75.076, 81.892], [28.568, 56.036], [28.568, 107.937]] },
  { fill: '#E3A9BF', points: [[28.568, 107.937], [75.076, 134.036], [75.076, 81.892]] },
  { fill: '#D884A2', points: [[75.076, 81.892], [75.118, 134.05], [121.654, 107.964]] },
];

export const WEDGE_FILLS = WEDGES.map((wedge) => wedge.fill);

/*
 * Each wedge is a sector of the mark, so its centroid sits on a spoke out of
 * the centre. Those bearings drive the revolve: the wedges swing to an even
 * 72° spacing and slide outward along their own spoke, opening the mark into a
 * five-pointed star before any of them becomes a card.
 */
const CENTRE = [75.076, 81.9];

const bearings = WEDGES.map(({ points }) => {
  const cx = (points[0][0] + points[1][0] + points[2][0]) / 3;
  const cy = (points[0][1] + points[1][1] + points[2][1]) / 3;
  return (Math.atan2(cy - CENTRE[1], cx - CENTRE[0]) * 180) / Math.PI;
});

/* Even spacing, assigned in bearing order so no wedge crosses another. */
const byBearing = bearings.map((angle, index) => ({ angle, index })).sort((a, b) => a.angle - b.angle);

export const STAR = WEDGES.map(() => ({ spin: 0, dx: 0, dy: 0 }));
byBearing.forEach(({ angle, index }, slot) => {
  const target = -126 + slot * 72;
  const radians = (target * Math.PI) / 180;
  STAR[index] = {
    /* The wedge's apex sits on the rotation centre, so a half turn on top of
       the correction swings its point outward — that is what makes a star
       rather than a pinwheel. The extra full turn is the revolve itself. */
    spin: target - angle + 360 + 180,
    dx: Math.cos(radians),
    dy: Math.sin(radians),
  };
});

/** How far out along its spoke a wedge slides, as a fraction of card width. */
export const STAR_REACH = 0.66;

/*
 * A triangle has to become a rectangle, and clip-path interpolates point by
 * point — so the wedge is expressed as four *distinct* points by splitting its
 * longest edge at the midpoint. Repeating a corner instead makes that corner
 * travel to two different rect corners, and the shape passes through a sliver
 * on the way. Winding is matched to the rect's so nothing turns inside out.
 */
function toQuad(triangle: Triangle) {
  const cx = (triangle[0][0] + triangle[1][0] + triangle[2][0]) / 3;
  const cy = (triangle[0][1] + triangle[1][1] + triangle[2][1]) / 3;

  const ordered = [...triangle].sort(
    (a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx),
  );

  let split = 0;
  let longest = -1;
  for (let i = 0; i < 3; i += 1) {
    const a = ordered[i];
    const b = ordered[(i + 1) % 3];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (length > longest) {
      longest = length;
      split = i;
    }
  }

  const quad: Point[] = [];
  for (let i = 0; i < 3; i += 1) {
    quad.push(ordered[i]);
    if (i === split) {
      const a = ordered[i];
      const b = ordered[(i + 1) % 3];
      quad.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
    }
  }

  /* Match the rect's winding (its shoelace area is positive). */
  const area = quad.reduce((sum, p, i) => {
    const n = quad[(i + 1) % quad.length];
    return sum + (p[0] * n[1] - n[0] * p[1]);
  }, 0);
  if (area < 0) quad.reverse();

  /* Lead with the corner nearest the box's top-left, so points pair up with
     the rect's TL → TR → BR → BL. */
  let start = 0;
  let nearest = Infinity;
  quad.forEach((p, i) => {
    const d = p[0] * p[0] + p[1] * p[1];
    if (d < nearest) {
      nearest = d;
      start = i;
    }
  });

  return [...quad.slice(start), ...quad.slice(0, start)];
}

/** clip-path for wedge `index`, in the card box's own coordinates. */
export function wedgeClip(index: number) {
  return `polygon(${toQuad(WEDGES[index].points).map(pct).join(', ')})`;
}

export const CARD_CLIP = 'polygon(0% 0%, 100% 0%, 100% 100%, 0% 100%)';

/* Where each card comes to rest, as a % of the stage. */
export const FAN = [
  { left: 24.0, top: 63.0, rotate: -16 },
  { left: 32.5, top: 59.0, rotate: -8 },
  { left: 41.5, top: 57.5, rotate: 0 },
  { left: 50.5, top: 59.0, rotate: 8 },
  { left: 59.0, top: 63.0, rotate: 16 },
];

export const CARD_RATIO = 560 / 862; // w / h — the deck's hairline ratio

/* A phone has no room for a card beside a column of text, so the hand sits
   lower and the featured card moves above the copy instead of next to it. */
export const FAN_PHONE = [
  { left: 6.0, top: 76.5, rotate: -18 },
  { left: 21.0, top: 72.5, rotate: -9 },
  { left: 37.0, top: 71.0, rotate: 0 },
  { left: 53.0, top: 72.5, rotate: 9 },
  { left: 68.0, top: 76.5, rotate: 18 },
];

export const LAYOUT = {
  wide: { fan: FAN, fanWidth: 15, feature: { left: 12, top: 24, rotate: 0, width: 19.5 } },
  phone: { fan: FAN_PHONE, fanWidth: 22, feature: { left: 32, top: 12, rotate: 0, width: 36 } },
};

/** The emblem's box, in % of the stage, per breakpoint. */
export const LOGO = {
  wide: { width: 11.7, top: 30 },
  phone: { width: 34, top: 30 },
};

/** The emblem itself, inline so its shell can outlive its wedges. */
export function Emblem() {
  return (
    <svg
      className="emblem"
      viewBox="0 0 150 163.825"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <g className="emblem__shell">
        <path
          d="M67.8476 1.85843L7.1455 35.8758C2.71945 38.3537 0 42.9325 0 47.8883V115.923C0 120.879 2.71945 125.458 7.1455 127.936L67.8476 161.953C72.2736 164.431 77.7125 164.431 82.1386 161.953L142.841 127.936C147.267 125.458 149.986 120.879 149.986 115.923V47.8883C149.986 42.9325 147.267 38.3537 142.841 35.8758L82.1524 1.85843C77.7264 -0.619478 72.2736 -0.619478 67.8476 1.85843Z"
          fill="#FAFBFB"
        />
        <path
          d="M140.107 118.401V45.4238L74.9931 8.92853L9.87885 45.4238V118.401L74.9931 154.883L140.107 118.401Z"
          fill="#2C2C2C"
          stroke="#B44F76"
          strokeWidth="0.343065"
          strokeMiterlimit="10"
        />
      </g>

      {/* The wedges the cards are cut from. The cards are laid over these
          pixel for pixel, so swapping one for the other is invisible. */}
      <g className="emblem__wedges">
        {WEDGES.map((wedge, index) => (
          <path
            key={index}
            d={`M${wedge.points.map((p) => p.join(' ')).join('L')}Z`}
            fill={wedge.fill}
          />
        ))}
      </g>
    </svg>
  );
}

/* The deck, in fan order — which is chapter order: the 10 fronts
   Code2Create, the ace ACM-VIT, the king ACM, the queen ACM-W and the
   jack VIT. Each SVG wraps the supplied club-suit scan, background
   removed and corners cut to the card's own radius. */
const FACES = [
  '/assets/svg/card-10.svg',
  '/assets/svg/card-ace.svg',
  '/assets/svg/card-king.svg',
  '/assets/svg/card-queen.svg',
  '/assets/svg/card-jack.svg',
];

export default function Cards() {
  return (
    <div className="cards" aria-hidden="true">
      {FAN.map((_slot, index) => (
        <div className="card" key={index} data-card={index}>
          <div className="card__wedge" style={{ background: WEDGE_FILLS[index] }} />
          <div className="card__face">
            <img className="card__scan" src={FACES[index]} alt="" />
          </div>
        </div>
      ))}
    </div>
  );
}

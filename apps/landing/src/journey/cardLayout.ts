/* Geometry shared by the emblem, the card deck and the GSAP journey. */
const LOGO_BOX = { w: 150, h: 163.825 };

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
  fill: string;
  points: Triangle;
}

const pct = ([x, y]: Point) => {
  const px = (x / LOGO_BOX.w) * 100;
  const py = (LOGO_BAND.offset + (y / LOGO_BOX.h) * LOGO_BAND.scale) * 100;
  return `${px.toFixed(3)}% ${py.toFixed(3)}%`;
};

export const WEDGES: readonly Wedge[] = [
  {
    fill: "#F1CEDF",
    points: [
      [121.682, 55.793],
      [75.076, 81.919],
      [75.076, 29.721],
    ],
  },
  {
    fill: "#D884A2",
    points: [
      [75.076, 29.748],
      [28.568, 55.807],
      [75.076, 81.892],
    ],
  },
  {
    fill: "#B44F76",
    points: [
      [75.076, 81.892],
      [28.568, 56.036],
      [28.568, 107.937],
    ],
  },
  {
    fill: "#E3A9BF",
    points: [
      [28.568, 107.937],
      [75.076, 134.036],
      [75.076, 81.892],
    ],
  },
  {
    fill: "#D884A2",
    points: [
      [75.076, 81.892],
      [75.118, 134.05],
      [121.654, 107.964],
    ],
  },
];

export const WEDGE_FILLS = WEDGES.map((wedge) => wedge.fill);

const CENTRE = [75.076, 81.9];
const bearings = WEDGES.map(({ points }) => {
  const cx = (points[0][0] + points[1][0] + points[2][0]) / 3;
  const cy = (points[0][1] + points[1][1] + points[2][1]) / 3;
  return (Math.atan2(cy - CENTRE[1], cx - CENTRE[0]) * 180) / Math.PI;
});
const byBearing = bearings
  .map((angle, index) => ({ angle, index }))
  .sort((a, b) => a.angle - b.angle);

export const STAR = WEDGES.map(() => ({ spin: 0, dx: 0, dy: 0 }));
byBearing.forEach(({ angle, index }, slot) => {
  const target = -126 + slot * 72;
  const radians = (target * Math.PI) / 180;
  STAR[index] = {
    spin: target - angle + 360 + 180,
    dx: Math.cos(radians),
    dy: Math.sin(radians),
  };
});

export const STAR_REACH = 0.66;

function toQuad(triangle: Triangle) {
  const cx = (triangle[0][0] + triangle[1][0] + triangle[2][0]) / 3;
  const cy = (triangle[0][1] + triangle[1][1] + triangle[2][1]) / 3;
  const ordered = [...triangle].sort(
    (a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx),
  );

  let split = 0;
  let longest = -1;
  for (let index = 0; index < 3; index += 1) {
    const current = ordered[index];
    const next = ordered[(index + 1) % 3];
    const length = Math.hypot(next[0] - current[0], next[1] - current[1]);
    if (length > longest) {
      longest = length;
      split = index;
    }
  }

  const quad: Point[] = [];
  for (let index = 0; index < 3; index += 1) {
    const current = ordered[index];
    quad.push(current);
    if (index === split) {
      const next = ordered[(index + 1) % 3];
      quad.push([(current[0] + next[0]) / 2, (current[1] + next[1]) / 2]);
    }
  }

  const area = quad.reduce((sum, point, index) => {
    const next = quad[(index + 1) % quad.length];
    return sum + (point[0] * next[1] - next[0] * point[1]);
  }, 0);
  if (area < 0) quad.reverse();

  let start = 0;
  let nearest = Infinity;
  quad.forEach((point, index) => {
    const distance = point[0] * point[0] + point[1] * point[1];
    if (distance < nearest) {
      nearest = distance;
      start = index;
    }
  });
  return [...quad.slice(start), ...quad.slice(0, start)];
}

export function wedgeClip(index: number) {
  return `polygon(${toQuad(WEDGES[index].points).map(pct).join(", ")})`;
}

export const CARD_CLIP = "polygon(0% 0%, 100% 0%, 100% 100%, 0% 100%)";

export const FAN = [
  { left: 24.0, top: 63.0, rotate: -16 },
  { left: 32.5, top: 59.0, rotate: -8 },
  { left: 41.5, top: 57.5, rotate: 0 },
  { left: 50.5, top: 59.0, rotate: 8 },
  { left: 59.0, top: 63.0, rotate: 16 },
];

export const CARD_RATIO = 560 / 862;

const FAN_PHONE = [
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

export const LOGO = {
  wide: { width: 11.7, top: 30 },
  phone: { width: 34, top: 30 },
};

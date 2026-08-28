/*
 * Botanical bloom animation.
 * Blossom geometry, the Plant SVG and the GSAP growth timeline are ported
 * verbatim from the C2C-Design-test prototype; only the scene wiring at the
 * bottom is adapted to drive the Code2Create timeline section.
 */
import gsap from 'gsap';
import { useGSAP } from '@gsap/react';
import { MorphSVGPlugin } from 'gsap/MorphSVGPlugin';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

gsap.registerPlugin(useGSAP, MorphSVGPlugin, ScrollTrigger);

type BloomView = 'front' | 'quarterLeft' | 'quarterRight' | 'sideLeft' | 'sideRight';

interface BloomProfile {
  pitch: number
  yaw: number
  cup: number
  ring: number
  core: number
  stamenLift: number
  angles: number[]
  scales: [number, number][]
  tones: string[]
}

interface BlossomDefinition {
  ax: number
  ay: number
  x: number
  y: number
  scale: number
  rotation: number
  start: number
  twist: number
  view: BloomView
}

interface FlowerMotion {
  stem: number
  swell: number
  hold: number
  burst: number
  relax: number
  pop: number
  lift: number
  budTurn: number
  sway: number
  tip: number
  curve: number
  order: number[]
  step: number
}

interface PetalLayer {
  angle: number
  depth: number
  petalIndex: number
  tone: string
}

interface BlossomProps {
  bloom: BlossomDefinition
  index: number
  part?: 'head' | 'stem'
}

function requiredElement<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`The botanical illustration is missing ${selector}.`);
  return element;
}

function requiredData(element: HTMLElement | SVGElement, key: string): string {
  const value = element.dataset[key];
  if (!value) throw new Error(`The botanical illustration is missing data-${key}.`);
  return value;
}

const foldedPetal =
  'M 0 0 C -1.2 -3.4 -2.2 -7.7 -1.6 -11.5 C -1 -14.5 -0.3 -16.8 0.4 -17.3 C 1.2 -16.1 1.9 -13.9 2.1 -11 C 2.5 -7.2 1.8 -3.2 0 0 Z';

const burstPetals = [
  'M 0 0 C -4 -2.2 -8.2 -5.4 -8.7 -10.1 C -9.2 -14.9 -6.1 -18.5 -2.7 -18.1 C -1.1 -17.9 -0.4 -16.3 0 -14.4 C 0.6 -16.3 1.7 -18.1 3.6 -18.2 C 7.2 -18.4 10 -15.1 9.7 -11 C 9.3 -6.5 4.4 -2 0 0 Z',
  'M 0 0 C -4.7 -2.4 -8.9 -5.8 -8.6 -10.9 C -8.3 -15.4 -5.3 -18.8 -2 -18.2 C -0.5 -17.9 0.2 -16.1 0.5 -14.2 C 1.3 -16.3 2.7 -18.2 4.5 -18 C 7.9 -17.7 10.2 -14.4 9.4 -10.4 C 8.7 -6.3 4.6 -2.2 0 0 Z',
  'M 0 0 C -3.3 -2.9 -7 -6.3 -7.3 -10.7 C -7.6 -15 -5 -17.8 -2.3 -17.7 C -0.7 -17.6 0 -16 0.4 -14.2 C 1.1 -16.1 2.4 -17.8 4.1 -17.7 C 7.3 -17.4 9.7 -14.1 9 -10.3 C 8.2 -6.1 4.1 -2 0 0 Z',
];

const closedBud =
  'M 0 0 C -3.7 -1.9 -4.8 -6.8 -3.2 -10.7 C -2.2 -13.2 -0.7 -14.8 0.6 -15 C 2.4 -13.8 3.8 -10.9 4 -7.7 C 4.3 -4.3 2.8 -1.2 0 0 Z';

const swollenBud =
  'M 0 0 C -4.6 -2.1 -6.2 -7.4 -4.5 -11.9 C -3.3 -15.3 -0.8 -17.5 1.2 -17.5 C 4 -16.1 5.7 -12.5 5.6 -8.6 C 5.5 -4.6 3.3 -1.2 0 0 Z';

const closedWhiteTip =
  'M -1 -10 C -1.7 -11.2 -1.4 -12.8 0 -13.4 C 1.4 -13.3 2.2 -11.8 1.5 -10.5 C 0.8 -9.7 -0.2 -9.6 -1 -10 Z';

const swollenWhiteTip =
  'M -3.4 -8.4 C -5.3 -9.9 -5.5 -13.5 -4.1 -15 C -3 -16.3 -1.5 -15.9 -1 -14.5 C -0.7 -13.7 -0.4 -13.2 0 -13 C -0.5 -15.9 0.3 -18.7 1.9 -19 C 3.7 -19.2 4.6 -16.9 3.8 -14.5 C 3.5 -13.6 3.7 -13 4.2 -12.8 C 5.2 -14.2 6.7 -13.4 6.5 -11.7 C 6.2 -9.5 3.7 -7.8 0.6 -7.4 C -1 -7.2 -2.5 -7.6 -3.4 -8.4 Z';

const openPetals = [
  'M 0 0 C -5.8 -2.5 -11.9 -6.9 -12.8 -13.3 C -13.7 -19.8 -9.4 -24.9 -4.2 -24.6 C -2 -24.5 -0.7 -20.7 0 -15.8 C 1.3 -20.8 2.9 -24.7 5.3 -24.6 C 10.4 -24.3 13.8 -19.7 12.7 -13.7 C 11.5 -7.3 5.8 -2.2 0 0 Z',
  'M 0 0 C -6.7 -2.8 -12.7 -7.4 -12.5 -14.5 C -12.3 -20.8 -8.2 -25.3 -3.2 -24.3 C -1.1 -23.8 -0.1 -20.3 0.5 -15.4 C 1.8 -20.4 3.6 -23.9 6.2 -23.6 C 11.6 -23 14.1 -18.3 12.5 -12.7 C 10.9 -6.9 5.3 -1.8 0 0 Z',
  'M 0 0 C -4.5 -3.8 -9.9 -8.5 -10.4 -14.7 C -10.9 -20.5 -7.2 -24.3 -3.4 -24 C -1.1 -23.8 -0.2 -20.3 0.3 -15.6 C 1.6 -20.3 3.4 -23.8 5.7 -23.5 C 10.7 -22.9 13.7 -18.1 12.1 -12.8 C 10.4 -7 5.1 -1.9 0 0 Z',
];

const bloomProfiles: Record<BloomView, BloomProfile> = {
  front: {
    pitch: 9,
    yaw: -5,
    cup: 0.18,
    ring: 1.05,
    core: 1.08,
    stamenLift: 0.16,
    angles: [-5, 66, 139, 214, 288],
    scales: [[0.96, 1.02], [1.04, 0.98], [0.98, 1.06], [1.07, 0.98], [0.95, 1.04]],
    tones: ['mid', 'back', 'mid', 'front', 'front'],
  },
  quarterLeft: {
    pitch: 34,
    yaw: -31,
    cup: 0.34,
    ring: 1.35,
    core: 1.12,
    stamenLift: 0.4,
    angles: [-18, 52, 126, 205, 280],
    scales: [[0.8, 0.88], [0.88, 0.94], [0.94, 0.98], [1.14, 1.08], [1.07, 1.03]],
    tones: ['back', 'back', 'mid', 'front', 'front'],
  },
  quarterRight: {
    pitch: 32,
    yaw: 33,
    cup: 0.36,
    ring: 1.38,
    core: 1.12,
    stamenLift: 0.42,
    angles: [-12, 62, 143, 224, 300],
    scales: [[1.1, 1.02], [1.15, 1.08], [0.95, 1], [0.82, 0.92], [0.76, 0.88]],
    tones: ['front', 'front', 'mid', 'back', 'back'],
  },
  sideLeft: {
    pitch: 51,
    yaw: -48,
    cup: 0.48,
    ring: 1.62,
    core: 1.16,
    stamenLift: 0.62,
    angles: [-34, 34, 105, 184, 258],
    scales: [[0.65, 0.78], [0.76, 0.86], [0.92, 0.98], [1.2, 1.12], [1.07, 1.02]],
    tones: ['back', 'back', 'mid', 'front', 'front'],
  },
  sideRight: {
    pitch: 49,
    yaw: 50,
    cup: 0.5,
    ring: 1.66,
    core: 1.16,
    stamenLift: 0.64,
    angles: [-18, 54, 132, 211, 286],
    scales: [[1.12, 1.02], [1.22, 1.12], [0.9, 0.96], [0.7, 0.82], [0.6, 0.76]],
    tones: ['front', 'front', 'mid', 'back', 'back'],
  },
};

const blossoms: BlossomDefinition[] = [
  { ax: 158, ay: 236, x: 147, y: 236, scale: 0.9, rotation: -22, start: 0.55, twist: -12, view: 'quarterLeft' },
  { ax: 177, ay: 229, x: 171, y: 222, scale: 0.78, rotation: 17, start: 0.72, twist: 9, view: 'quarterRight' },
  { ax: 194, ay: 215, x: 199, y: 201, scale: 0.84, rotation: -7, start: 0.95, twist: -8, view: 'quarterLeft' },
  { ax: 163, ay: 239, x: 155, y: 254, scale: 0.78, rotation: 18, start: 1.62, twist: 10, view: 'sideRight' },
  { ax: 217, ay: 197, x: 226, y: 179, scale: 0.92, rotation: 9, start: 1.78, twist: -9, view: 'quarterLeft' },
  { ax: 237, ay: 184, x: 245, y: 191, scale: 0.75, rotation: -13, start: 2.02, twist: 8, view: 'sideRight' },
  { ax: 261, ay: 165, x: 274, y: 158, scale: 0.94, rotation: 15, start: 2.18, twist: 11, view: 'front' },
  { ax: 278, ay: 138, x: 296, y: 132, scale: 0.83, rotation: -15, start: 2.82, twist: -10, view: 'sideLeft' },
  { ax: 274, ay: 132, x: 286, y: 112, scale: 0.84, rotation: 18, start: 2.95, twist: 8, view: 'quarterRight' },
  { ax: 244, ay: 149, x: 242, y: 129, scale: 0.86, rotation: -13, start: 3.16, twist: -9, view: 'quarterRight' },
  { ax: 234, ay: 124, x: 217, y: 104, scale: 0.92, rotation: 6, start: 3.85, twist: 11, view: 'quarterLeft' },
  { ax: 225, ay: 96, x: 202, y: 79, scale: 0.88, rotation: -24, start: 4, twist: -8, view: 'sideRight' },
  { ax: 226, ay: 79, x: 226, y: 62, scale: 0.8, rotation: 17, start: 4.18, twist: 10, view: 'quarterLeft' },
  { ax: 225, ay: 49, x: 218, y: 33, scale: 0.94, rotation: -9, start: 4.78, twist: -10, view: 'quarterRight' },
  { ax: 242, ay: 154, x: 205, y: 132, scale: 0.76, rotation: 19, start: 5.05, twist: 8, view: 'sideLeft' },
  { ax: 260, ay: 122, x: 256, y: 96, scale: 0.74, rotation: -18, start: 5.18, twist: -8, view: 'quarterLeft' },
];

const flowerMotions: FlowerMotion[] = [
  { stem: 0.46, swell: 0.62, hold: 0.08, burst: 0.17, relax: 0.84, pop: 1.072, lift: 10, budTurn: -3.5, sway: -1.2, tip: 1.1, curve: -3.1, order: [3, 0, 4, 1, 2], step: 0.018 },
  { stem: 0.36, swell: 0.5, hold: 0.04, burst: 0.14, relax: 0.72, pop: 1.05, lift: 7, budTurn: 2.2, sway: 0.8, tip: 0.96, curve: 2.7, order: [1, 0, 2, 4, 3], step: 0.014 },
  { stem: 0.42, swell: 0.58, hold: 0.1, burst: 0.2, relax: 0.9, pop: 1.082, lift: 9, budTurn: -1.5, sway: -1.7, tip: 1.14, curve: -1.4, order: [4, 0, 3, 1, 2], step: 0.021 },
  { stem: 0.34, swell: 0.47, hold: 0.03, burst: 0.13, relax: 0.68, pop: 1.045, lift: 6.5, budTurn: 4, sway: 1.4, tip: 0.92, curve: 3.5, order: [0, 1, 4, 2, 3], step: 0.012 },
  { stem: 0.49, swell: 0.65, hold: 0.12, burst: 0.19, relax: 0.96, pop: 1.088, lift: 10.5, budTurn: -4.2, sway: -0.7, tip: 1.16, curve: -3.8, order: [2, 3, 1, 4, 0], step: 0.022 },
  { stem: 0.38, swell: 0.52, hold: 0.06, burst: 0.15, relax: 0.76, pop: 1.054, lift: 7.5, budTurn: 3.1, sway: 1.8, tip: 1, curve: 2.1, order: [4, 3, 0, 2, 1], step: 0.016 },
  { stem: 0.44, swell: 0.6, hold: 0.07, burst: 0.18, relax: 0.86, pop: 1.078, lift: 9.5, budTurn: 1.3, sway: 0.5, tip: 1.08, curve: 1.1, order: [1, 2, 0, 3, 4], step: 0.019 },
  { stem: 0.33, swell: 0.46, hold: 0.02, burst: 0.12, relax: 0.66, pop: 1.04, lift: 6, budTurn: -5.1, sway: -2, tip: 0.9, curve: -4.2, order: [3, 4, 2, 0, 1], step: 0.011 },
  { stem: 0.4, swell: 0.55, hold: 0.09, burst: 0.16, relax: 0.8, pop: 1.064, lift: 8, budTurn: 4.5, sway: 1.1, tip: 1.04, curve: 3.9, order: [0, 4, 1, 3, 2], step: 0.017 },
  { stem: 0.47, swell: 0.63, hold: 0.11, burst: 0.2, relax: 0.92, pop: 1.086, lift: 10, budTurn: -2.6, sway: -1.4, tip: 1.13, curve: -2.4, order: [2, 1, 3, 0, 4], step: 0.023 },
  { stem: 0.35, swell: 0.49, hold: 0.05, burst: 0.14, relax: 0.71, pop: 1.048, lift: 7, budTurn: 2.7, sway: 1.6, tip: 0.95, curve: 2.9, order: [4, 0, 1, 2, 3], step: 0.013 },
  { stem: 0.43, swell: 0.57, hold: 0.08, burst: 0.17, relax: 0.83, pop: 1.07, lift: 8.5, budTurn: -4.8, sway: -2.1, tip: 1.07, curve: -3.6, order: [1, 4, 0, 3, 2], step: 0.018 },
  { stem: 0.39, swell: 0.53, hold: 0.04, burst: 0.15, relax: 0.78, pop: 1.058, lift: 7.5, budTurn: 3.8, sway: 1.9, tip: 1.02, curve: 3.2, order: [3, 2, 4, 1, 0], step: 0.015 },
  { stem: 0.51, swell: 0.67, hold: 0.13, burst: 0.21, relax: 0.98, pop: 1.092, lift: 11, budTurn: -1.1, sway: -0.5, tip: 1.18, curve: -0.8, order: [0, 3, 1, 4, 2], step: 0.024 },
  { stem: 0.32, swell: 0.45, hold: 0.03, burst: 0.12, relax: 0.64, pop: 1.038, lift: 6, budTurn: 5.2, sway: 2.2, tip: 0.88, curve: 4.4, order: [2, 4, 3, 0, 1], step: 0.01 },
  { stem: 0.45, swell: 0.61, hold: 0.1, burst: 0.18, relax: 0.88, pop: 1.08, lift: 9, budTurn: -3.2, sway: -1.8, tip: 1.11, curve: -2.8, order: [4, 1, 2, 0, 3], step: 0.02 },
];

const flowerDepths = [1.08, 0.94, 1.13, 0.9, 1.06, 0.96, 1.14, 0.88, 1.02, 1.1, 0.98, 0.91, 1.07, 1.12, 0.87, 1.04];

const stamenSpecs: [number, number][] = [
  [-82, 9.4], [-54, 11.2], [-27, 9.8], [2, 12], [31, 10.6], [61, 9.5],
  [94, 10.2], [128, 9.1], [164, 10.4], [201, 8.8], [238, 9.7], [278, 8.9],
];

export function Blossom({ bloom, index, part = 'head' }: BlossomProps) {
  const motionSpec = flowerMotions[index];
  const dx = bloom.x - bloom.ax;
  const dy = bloom.y - bloom.ay;
  const stemAngle = (Math.atan2(dy, dx) * 180) / Math.PI;
  const stemControlOne = [dx * 0.28 + motionSpec.curve * 0.34, dy * 0.28];
  const stemControlTwo = [dx * 0.72 + motionSpec.curve * 0.16, dy * 0.74];
  const stemPath = `M 0 0 C ${stemControlOne[0]} ${stemControlOne[1]} ${stemControlTwo[0]} ${stemControlTwo[1]} ${dx} ${dy}`;
  const stemLength = Math.hypot(dx, dy) || 1;
  const perpendicular = [-dy / stemLength, dx / stemLength];
  const stemRibbon = `M ${perpendicular[0] * 1.7} ${perpendicular[1] * 1.7} C ${stemControlOne[0] + perpendicular[0] * 1.35} ${stemControlOne[1] + perpendicular[1] * 1.35} ${stemControlTwo[0] + perpendicular[0] * 0.84} ${stemControlTwo[1] + perpendicular[1] * 0.84} ${dx + perpendicular[0] * 0.58} ${dy + perpendicular[1] * 0.58} L ${dx - perpendicular[0] * 0.58} ${dy - perpendicular[1] * 0.58} C ${stemControlTwo[0] - perpendicular[0] * 0.84} ${stemControlTwo[1] - perpendicular[1] * 0.84} ${stemControlOne[0] - perpendicular[0] * 1.35} ${stemControlOne[1] - perpendicular[1] * 1.35} ${-perpendicular[0] * 1.7} ${-perpendicular[1] * 1.7} Z`;

  if (part === 'stem') {
    return (
      <g
        className="blossom-stem"
        data-index={index}
        transform={`translate(${bloom.ax} ${bloom.ay})`}
      >
        <g className="pedicel-system">
          <ellipse
            className="branch-collar"
            rx="2.25"
            ry="1.55"
            transform={`rotate(${stemAngle})`}
          />
          <path className="flower-pedicel-ribbon" d={stemRibbon} />
          <path className="flower-pedicel-shadow" d={stemPath} pathLength="1000" />
          <path className="flower-pedicel" d={stemPath} pathLength="1000" />
        </g>
      </g>
    );
  }

  const profile = bloomProfiles[bloom.view];
  const depthGain = flowerDepths[index];
  const radians = Math.PI / 180;
  const pitch = profile.pitch * radians;
  const yaw = profile.yaw * radians;
  const cosPitch = Math.cos(pitch);
  const sinPitch = Math.sin(pitch);
  const cosYaw = Math.cos(yaw);
  const sinYaw = Math.sin(yaw);
  const planeU = { x: cosYaw, y: sinPitch * sinYaw, z: -cosPitch * sinYaw };
  const planeV = { x: 0, y: cosPitch, z: sinPitch };
  const planeNormal = { x: sinYaw, y: -sinPitch * cosYaw, z: cosPitch * cosYaw };
  const projectPoint = (x: number, y: number, z = 0) => ({
    x: x * planeU.x + y * planeV.x + z * planeNormal.x,
    y: x * planeU.y + y * planeV.y + z * planeNormal.y,
  });
  const formatMatrix = (a: number, b: number, c: number, d: number, e = 0, f = 0) =>
    `matrix(${a.toFixed(4)} ${b.toFixed(4)} ${c.toFixed(4)} ${d.toFixed(4)} ${e.toFixed(3)} ${f.toFixed(3)})`;

  const petalLayers = profile.angles
    .map((baseAngle, petalIndex) => {
      const angle = baseAngle + (((index * 7 + petalIndex * 11) % 9) - 4) * 0.9;
      const theta = angle * radians;
      const outwardDepth =
        Math.sin(theta) * planeU.z - Math.cos(theta) * planeV.z +
        profile.cup * planeNormal.z;
      const depth = outwardDepth * depthGain;
      return {
        angle,
        depth,
        petalIndex,
        tone: depth > 0.2 ? 'front' : depth < -0.12 ? 'back' : profile.tones[petalIndex],
      };
    })
    .sort((a, b) => a.depth - b.depth);

  const renderPetal = ({ angle, depth, petalIndex, tone }: PetalLayer) => {
    const [baseScaleX, baseScaleY] = profile.scales[petalIndex];
    const depthScale = 1 + depth * 0.16;
    const scaleX = baseScaleX * depthScale;
    const scaleY = baseScaleY * (1 + depth * 0.08);
    const burstShape = burstPetals[(index + petalIndex) % burstPetals.length];
    const finalShape = openPetals[(index + petalIndex) % openPetals.length];
    const projectedTransform = (
      angleOffset: number,
      scaleAmountX: number,
      scaleAmountY: number,
      cupAmount: number,
      ringAmount: number,
    ) => {
      const theta = (angle + angleOffset) * radians;
      const cosTheta = Math.cos(theta);
      const sinTheta = Math.sin(theta);
      const tangent = {
        x: cosTheta * planeU.x + sinTheta * planeV.x,
        y: cosTheta * planeU.y + sinTheta * planeV.y,
      };
      const inward = {
        x: -sinTheta * planeU.x + cosTheta * planeV.x - cupAmount * planeNormal.x,
        y: -sinTheta * planeU.y + cosTheta * planeV.y - cupAmount * planeNormal.y,
      };
      const root = projectPoint(
        Math.sin(theta) * profile.ring * ringAmount,
        -Math.cos(theta) * profile.ring * ringAmount,
        0,
      );
      return formatMatrix(
        tangent.x * scaleX * scaleAmountX,
        tangent.y * scaleX * scaleAmountX,
        inward.x * scaleY * scaleAmountY,
        inward.y * scaleY * scaleAmountY,
        root.x,
        root.y,
      );
    };
    const foldedTransform = projectedTransform(
      petalIndex % 2 ? 5.5 : -5,
      0.14,
      0.34,
      profile.cup * 1.55,
      0.18,
    );
    const burstTransform = projectedTransform(
      petalIndex % 2 ? 3.4 : -2.8,
      0.72,
      0.62,
      profile.cup * 1.65,
      0.5,
    );
    const openTransform = projectedTransform(0, 1, 1, profile.cup, 1);

    return (
      <g
        className={`petal-wrap petal-wrap-${petalIndex + 1} ${depth > 0.06 ? 'petal-near' : 'petal-far'}`}
        data-depth={depth.toFixed(3)}
        data-folded-transform={foldedTransform}
        data-burst-transform={burstTransform}
        data-open-transform={openTransform}
        data-release={motionSpec.order.indexOf(petalIndex) * motionSpec.step}
        data-duration={motionSpec.relax + ((index + petalIndex * 2) % 3) * 0.035}
        transform={openTransform}
        key={`${angle}-${petalIndex}`}
      >
        <path
          className={`bloom-petal petal-shape petal-${tone}`}
          d={foldedPetal}
          data-burst={burstShape}
          data-open={finalShape}
        />
        <path
          className="petal-sheen petal-shape"
          d={foldedPetal}
          data-burst={burstShape}
          data-open={finalShape}
        />
        <path
          className="petal-fold"
          d="M -0.2 -2 C -1 -7 -3.7 -13.5 -3.1 -19 C -1.1 -17.4 0.6 -12 0.45 -4 Z"
        />
        <path
          className="petal-cleft"
          d="M -3.8 -23.1 C -1.9 -22.6 -0.7 -18.4 0 -15.7 C 0.8 -18.5 2 -22.3 4.2 -23"
        />
        <path className="petal-vein" d="M 0 -2 C -0.8 -6.8 -0.5 -12.2 0.2 -17.8" />
      </g>
    );
  };

  const farPetals = petalLayers.filter(({ depth }) => depth <= 0.06);
  const nearPetals = petalLayers.filter(({ depth }) => depth > 0.06);
  const corePlaneTransform = formatMatrix(
    planeU.x * profile.core,
    planeU.y * profile.core,
    planeV.x * profile.core,
    planeV.y * profile.core,
  );
  const projectedStamens = stamenSpecs.map(([angle, length], stamenIndex) => {
    const theta = (angle + ((index * 5 + stamenIndex * 3) % 7) - 3) * radians;
    const baseRadius = 1.5 + (stamenIndex % 3) * 0.18;
    const base = projectPoint(
      Math.sin(theta) * baseRadius,
      -Math.cos(theta) * baseRadius,
      0.25,
    );
    const liftedLength = length * (0.96 + ((index + stamenIndex) % 4) * 0.035);
    const tip = projectPoint(
      Math.sin(theta) * liftedLength,
      -Math.cos(theta) * liftedLength,
      liftedLength * profile.stamenLift,
    );
    const controlOne = {
      x: base.x + (tip.x - base.x) * 0.44 - planeNormal.x * 0.45,
      y: base.y + (tip.y - base.y) * 0.44 - planeNormal.y * 0.45,
    };
    const controlTwo = {
      x: base.x + (tip.x - base.x) * 0.78 + planeNormal.x * 0.35,
      y: base.y + (tip.y - base.y) * 0.78 + planeNormal.y * 0.35,
    };
    const tipDepth =
      Math.sin(theta) * liftedLength * planeU.z -
      Math.cos(theta) * liftedLength * planeV.z +
      liftedLength * profile.stamenLift * planeNormal.z;
    return { base, controlOne, controlTwo, tip, tipDepth, angle, stamenIndex };
  });
  const projectedPistils = [-18, 4, 24].map((angle, pistilIndex) => {
    const theta = (angle + index * 2.4) * radians;
    const height = 5.4 + pistilIndex * 0.75 + (index % 3) * 0.35;
    return {
      base: projectPoint(Math.sin(theta) * 0.65, -Math.cos(theta) * 0.65, 0.4),
      tip: projectPoint(Math.sin(theta) * 1.3, -Math.cos(theta) * 1.3, height),
      pistilIndex,
    };
  });

  return (
    <g
      className="blossom"
      data-index={index}
      data-start={bloom.start}
      data-twist={bloom.twist}
      transform={`translate(${bloom.ax} ${bloom.ay})`}
    >
      <g className="head-anchor" transform={`translate(${dx} ${dy})`}>
        <g
          className="flower-orientation"
          transform={`rotate(${bloom.rotation}) scale(${bloom.scale * 1.12})`}
        >
          <g className="blossom-motion">
            <g className="flower-head">
              <g className="bloom-bud">
                <path className="bud-core" d={closedBud} data-swollen={swollenBud} />
                <g className="white-tip-cap">
                  <path
                    className="white-tip"
                    d={closedWhiteTip}
                    data-swollen={swollenWhiteTip}
                  />
                  <g className="white-tip-seams">
                    <path className="white-tip-seam" d="M -2.8 -9.6 C -2.5 -12.2 -2.2 -14 -1.4 -15.2" />
                    <path className="white-tip-seam" d="M 0.2 -9 C 0.3 -12.2 0.8 -15.5 1.9 -17.5" />
                    <path className="white-tip-seam" d="M 2.8 -9.5 C 3.5 -11.2 4.2 -12.1 5 -12.2" />
                  </g>
                </g>
                <g className="sepal-ring">
                  {[-40, -20, 0, 20, 40].map((angle) => (
                    <path
                      d="M 0 0 C -1.8 -2.4 -1.8 -6.5 0 -9.4 C 1.8 -6.4 1.9 -2.5 0 0 Z"
                      transform={`rotate(${angle})`}
                      key={angle}
                    />
                  ))}
                </g>
                <path className="bud-glint" d="M -2.6 -10.7 C -1.2 -12.6 0.8 -13.2 2.3 -12" />
              </g>

              <g className="petal-plane petal-plane-back">
                {farPetals.map(renderPetal)}
              </g>

              <g className="heart-motion">
                <g className="nectar-plane" transform={corePlaneTransform}>
                  <ellipse className="nectar-shadow" rx="4.8" ry="4.15" />
                  <ellipse className="flower-centre" rx="3.65" ry="3.1" />
                  {[-72, 0, 72, 144, 216].map((angle, glandIndex) => {
                    const theta = angle * radians;
                    return (
                      <circle
                        className="nectar-gland"
                        cx={Math.sin(theta) * 2.15}
                        cy={-Math.cos(theta) * 1.85}
                        r={0.52 + (glandIndex % 2) * 0.08}
                        key={angle}
                      />
                    );
                  })}
                  <circle className="flower-centre-light" cx="-0.72" cy="-0.65" r="0.72" />
                </g>

              </g>

              <g className="petal-plane petal-plane-front">
                {nearPetals.map(renderPetal)}
              </g>

              <g className="heart-motion foreground-reproductive">
                {projectedStamens.map(({ base, controlOne, controlTwo, tip, angle }) => (
                  <g className="stamen stamen-foreground" key={`front-${angle}`}>
                    <path
                      className="stamen-filament"
                      pathLength="1000"
                      d={`M ${base.x.toFixed(2)} ${base.y.toFixed(2)} C ${controlOne.x.toFixed(2)} ${controlOne.y.toFixed(2)} ${controlTwo.x.toFixed(2)} ${controlTwo.y.toFixed(2)} ${tip.x.toFixed(2)} ${tip.y.toFixed(2)}`}
                    />
                    <circle
                      className="stamen-anther"
                      cx={tip.x.toFixed(2)}
                      cy={tip.y.toFixed(2)}
                      r="1.12"
                    />
                  </g>
                ))}
                {projectedPistils.map(({ base, tip, pistilIndex }) => (
                  <g className="pistil" key={pistilIndex}>
                    <path
                      className="pistil-style"
                      pathLength="1000"
                      d={`M ${base.x.toFixed(2)} ${base.y.toFixed(2)} Q ${((base.x + tip.x) * 0.5 + planeNormal.x * 0.7).toFixed(2)} ${((base.y + tip.y) * 0.5 + planeNormal.y * 0.7).toFixed(2)} ${tip.x.toFixed(2)} ${tip.y.toFixed(2)}`}
                    />
                    <circle
                      className="pistil-tip"
                      cx={tip.x.toFixed(2)}
                      cy={tip.y.toFixed(2)}
                      r="1.12"
                    />
                  </g>
                ))}
              </g>
            </g>
          </g>
        </g>
      </g>
    </g>
  );
}

export function Plant() {
  return (
    <div
      className="plant-shell"
      aria-label="The plant grows from buds to full bloom as the timeline advances"
      role="img"
    >
      <div className="plant-aura" aria-hidden="true" />
      {/* The pot-and-trunk plate lives OUTSIDE the animated SVG: inside it,
          the 400KB raster was re-composited on every scrubbed frame of the
          bloom. As a sibling <img> it rasterizes once and the SVG above it
          repaints only its own vectors. Same box, same contain fit, so the
          geometry is identical (the plate is exactly 387×493, like the
          viewBox). */}
      <img
        className="plant-base"
        src="/plants/plant-01.svg"
        width="387"
        height="493"
        alt=""
        aria-hidden="true"
      />
      <svg
        className="plant-svg"
        viewBox="0 0 387 493"
        preserveAspectRatio="xMidYMid meet"
        aria-hidden="true"
      >
        <defs>
          <radialGradient id="petalFront" cx="46%" cy="80%" r="82%">
            <stop offset="0" stopColor="#b85478" />
            <stop offset="0.1" stopColor="#df91aa" />
            <stop offset="0.27" stopColor="#f4cbd7" />
            <stop offset="0.56" stopColor="#fff2f5" />
            <stop offset="1" stopColor="#fffefd" />
          </radialGradient>
          <radialGradient id="petalMid" cx="43%" cy="79%" r="84%">
            <stop offset="0" stopColor="#a74369" />
            <stop offset="0.12" stopColor="#d7829f" />
            <stop offset="0.34" stopColor="#f1c2d0" />
            <stop offset="0.67" stopColor="#fdebf0" />
            <stop offset="1" stopColor="#fffafa" />
          </radialGradient>
          <radialGradient id="petalBack" cx="42%" cy="77%" r="82%">
            <stop offset="0" stopColor="#8d345a" />
            <stop offset="0.24" stopColor="#bd6484" />
            <stop offset="0.58" stopColor="#e4a5b9" />
            <stop offset="0.82" stopColor="#f4d5df" />
            <stop offset="1" stopColor="#fbecef" />
          </radialGradient>
          <linearGradient id="petalSheen" x1="0.14" y1="0.88" x2="0.7" y2="0.08">
            <stop offset="0" stopColor="#fff" stopOpacity="0" />
            <stop offset="0.45" stopColor="#fff7fa" stopOpacity="0.2" />
            <stop offset="0.78" stopColor="#fff" stopOpacity="0.5" />
            <stop offset="1" stopColor="#fff" stopOpacity="0.08" />
          </linearGradient>
          <linearGradient id="petalFold" x1="0.18" y1="0.9" x2="0.74" y2="0.08">
            <stop offset="0" stopColor="#6f2449" stopOpacity="0.42" />
            <stop offset="0.48" stopColor="#b4577e" stopOpacity="0.2" />
            <stop offset="1" stopColor="#fff" stopOpacity="0" />
          </linearGradient>
          <radialGradient id="flowerCore" cx="45%" cy="45%" r="65%">
            <stop offset="0" stopColor="#f7d58a" />
            <stop offset="0.55" stopColor="#b99045" />
            <stop offset="1" stopColor="#68542b" />
          </radialGradient>
          <linearGradient id="budTint" x1="0" y1="1" x2="0.7" y2="0">
            <stop offset="0" stopColor="#7d2748" />
            <stop offset="0.52" stopColor="#c94f70" />
            <stop offset="1" stopColor="#e88ca4" />
          </linearGradient>
          <linearGradient id="pedicelTint" x1="0" y1="1" x2="0.85" y2="0">
            <stop offset="0" stopColor="#4c3425" />
            <stop offset="0.34" stopColor="#704333" />
            <stop offset="0.74" stopColor="#a95158" />
            <stop offset="1" stopColor="#d16b79" />
          </linearGradient>
          <radialGradient id="whiteTipTint" cx="42%" cy="28%" r="78%">
            <stop offset="0" stopColor="#fffefd" />
            <stop offset="0.56" stopColor="#fff6f7" />
            <stop offset="0.82" stopColor="#f4ced8" />
            <stop offset="1" stopColor="#d77b98" />
          </radialGradient>
        </defs>

        <g className="pedicel-canopy">
          {blossoms.map((bloom, index) => (
            <Blossom
              bloom={bloom}
              index={index}
              part="stem"
              key={`stem-${bloom.x}-${bloom.y}`}
            />
          ))}
        </g>

        <g className="blossom-canopy">
          {blossoms.map((bloom, index) => (
            <Blossom
              bloom={bloom}
              index={index}
              part="head"
              key={`head-${bloom.x}-${bloom.y}`}
            />
          ))}
        </g>
      </svg>
      <div className="plant-shadow" aria-hidden="true" />
    </div>
  );
}

/**
 * Builds the growth timeline (ported from the prototype's App component) and
 * hands it back unattached, so the page's master scroll timeline can nest it.
 */
interface BloomTimelineOptions {
  moments?: boolean
}

export function createBloomTimeline(
  story: HTMLElement,
  { moments = true }: BloomTimelineOptions = {},
) {
  /* `story` may itself be the scene when the caller pins a single stage. */
  const scene = story.querySelector<HTMLElement>('.scene') ?? story;
  const blossomGroups = gsap.utils.toArray<SVGGElement>('.blossom', story);
  const copyMoments = moments ? gsap.utils.toArray<HTMLElement>('.moment', story) : [];

  if (copyMoments.length) {
    gsap.set(copyMoments, { autoAlpha: 0, filter: 'blur(3px)', y: 26 });
    gsap.set(copyMoments[0], { autoAlpha: 1, filter: 'blur(0px)', y: 0 });
  }

  const growthTimeline = gsap.timeline({ defaults: { ease: 'none' } });

  blossomGroups.forEach((blossom) => {
    const blossomIndex = Number(requiredData(blossom, 'index'));
    const motionSpec = flowerMotions[blossomIndex];
    const start = Number(requiredData(blossom, 'start'));
    const twist = Number(requiredData(blossom, 'twist'));
    const orientationOffset = twist * 0.16 + motionSpec.budTurn * 0.2;
    const headTransform = (scale: number, rotation: number) =>
      `rotate(${(orientationOffset + rotation).toFixed(3)}) scale(${scale.toFixed(4)})`;
    const stemGroup = requiredElement<SVGGElement>(
      story,
      `.blossom-stem[data-index="${blossomIndex}"]`,
    );
    const motion = requiredElement<SVGGElement>(blossom, '.blossom-motion');
    const pedicels = gsap.utils.toArray<SVGPathElement>(
      '.flower-pedicel, .flower-pedicel-shadow',
      stemGroup,
    );
    const pedicelRibbon = requiredElement<SVGPathElement>(stemGroup, '.flower-pedicel-ribbon');
    const branchCollar = requiredElement<SVGEllipseElement>(stemGroup, '.branch-collar');
    const head = requiredElement<SVGGElement>(blossom, '.flower-head');
    const petalWraps = gsap.utils.toArray<SVGGElement>('.petal-wrap', blossom);
    const petalShapes = gsap.utils.toArray<SVGPathElement>('.petal-shape', blossom);
    const folds = gsap.utils.toArray<SVGPathElement>('.petal-fold', blossom);
    const clefts = gsap.utils.toArray<SVGPathElement>('.petal-cleft', blossom);
    const veins = gsap.utils.toArray<SVGPathElement>('.petal-vein', blossom);
    const hearts = gsap.utils.toArray<SVGGElement>('.heart-motion', blossom);
    const reproductivePairs = gsap.utils.toArray<SVGGElement>('.stamen, .pistil', blossom);
    const reproductiveStems = gsap.utils.toArray<SVGPathElement>(
      '.stamen-filament, .pistil-style',
      blossom,
    );
    const reproductiveTips = gsap.utils.toArray<SVGCircleElement>(
      '.stamen-anther, .pistil-tip',
      blossom,
    );
    const bud = requiredElement<SVGGElement>(blossom, '.bloom-bud');
    const budCore = requiredElement<SVGPathElement>(blossom, '.bud-core');
    const whiteTipCap = requiredElement<SVGGElement>(blossom, '.white-tip-cap');
    const whiteTip = requiredElement<SVGPathElement>(blossom, '.white-tip');
    const whiteTipSeams = gsap.utils.toArray<SVGPathElement>('.white-tip-seam', blossom);
    const budGlint = requiredElement<SVGPathElement>(blossom, '.bud-glint');
    const sepals = requiredElement<SVGGElement>(blossom, '.sepal-ring');
    const swellStart = Math.max(0, start - motionSpec.swell * 0.34);
    const stemStart = Math.max(0, swellStart - motionSpec.stem * 0.82);
    const burstStart = swellStart + motionSpec.swell + motionSpec.hold;
    const whiteTipPeakScale = Math.max(
      0.82,
      Math.min(0.92, 0.86 + (motionSpec.tip - 1) * 0.25),
    );

    gsap.set(motion, {
      autoAlpha: 0,
    });
    /* 1000, not 1: GSAP rounds strokeDashoffset to whole numbers, so a path
       normalised to pathLength="1" can only be offset by 0 or 1 and the stem
       snaps into existence instead of growing. */
    gsap.set(pedicels, { strokeDasharray: 1000, strokeDashoffset: 1000 });
    gsap.set(pedicelRibbon, {
      autoAlpha: 0,
    });
    gsap.set(branchCollar, {
      autoAlpha: 0,
      scale: 0.62,
      transformOrigin: '50% 50%',
    });
    gsap.set(head, {
      autoAlpha: 0,
      attr: { transform: headTransform(0.68, motionSpec.sway * 0.38) },
    });
    petalWraps.forEach((wrap) =>
      wrap.setAttribute('transform', requiredData(wrap, 'foldedTransform')),
    );
    gsap.set(petalShapes, { autoAlpha: 0 });
    gsap.set(folds, {
      autoAlpha: 0,
      scaleY: 0.35,
      transformOrigin: '50% 100%',
    });
    gsap.set(clefts, { autoAlpha: 0, strokeDasharray: 12, strokeDashoffset: 12 });
    gsap.set(veins, { autoAlpha: 0, strokeDasharray: 18, strokeDashoffset: 18 });
    gsap.set(hearts, { autoAlpha: 0, scale: 0.62, transformOrigin: '50% 50%' });
    gsap.set(reproductiveStems, { strokeDasharray: 1000, strokeDashoffset: 1000 });
    gsap.set(reproductiveTips, { autoAlpha: 0 });
    gsap.set(bud, { autoAlpha: 1 });
    gsap.set(budCore, {
      autoAlpha: 1,
      scale: 0.72,
      transformOrigin: '50% 100%',
    });
    gsap.set(whiteTipCap, {
      autoAlpha: 0,
      y: 1.3,
      scale: 0.22,
      transformOrigin: '50% 82%',
    });
    gsap.set(whiteTipSeams, {
      autoAlpha: 0,
      strokeDasharray: 8,
      strokeDashoffset: 8,
    });
    gsap.set(budGlint, { autoAlpha: 0 });
    gsap.set(sepals, { scale: 0.64, rotation: -7, transformOrigin: '50% 76%' });

    growthTimeline
      .to(motion, { autoAlpha: 1, duration: 0.05 }, stemStart)
      .to(
        branchCollar,
        { autoAlpha: 1, scale: 1, duration: motionSpec.stem * 0.34, ease: 'power1.out' },
        stemStart,
      )
      .to(
        pedicelRibbon,
        { autoAlpha: 1, duration: motionSpec.stem * 0.24, ease: 'power1.out' },
        stemStart + motionSpec.stem * 0.76,
      )
      .to(
        pedicels,
        { duration: motionSpec.stem, strokeDashoffset: 0, ease: 'power1.inOut' },
        stemStart,
      )
      .to(head, { autoAlpha: 1, duration: 0.08 }, stemStart + motionSpec.stem * 0.72)
      .to(
        head,
        {
          duration: motionSpec.stem * 0.92,
          attr: { transform: headTransform(0.77, motionSpec.sway * 0.52) },
          ease: 'power2.out',
        },
        stemStart + motionSpec.stem * 0.12,
      )
      .to(
        head,
        {
          duration: motionSpec.swell,
          attr: { transform: headTransform(0.88, motionSpec.sway * 0.68) },
          ease: 'power1.inOut',
        },
        swellStart,
      )
      .to(
        budCore,
        {
          duration: motionSpec.swell,
          scale: 1.02 + (motionSpec.tip - 1) * 0.28,
          morphSVG: { shape: requiredData(budCore, 'swollen'), shapeIndex: 0 },
          ease: 'power2.inOut',
        },
        swellStart,
      )
      .to(whiteTipCap, { autoAlpha: 1, duration: 0.09 }, swellStart + motionSpec.swell * 0.1)
      .to(
        whiteTip,
        {
          duration: motionSpec.swell * 0.9,
          morphSVG: { shape: requiredData(whiteTip, 'swollen'), shapeIndex: 0 },
          ease: 'power2.inOut',
        },
        swellStart + motionSpec.swell * 0.1,
      )
      .to(
        whiteTipCap,
        {
          duration: motionSpec.swell * 0.9,
          y: 0,
          scale: whiteTipPeakScale,
          ease: 'power2.inOut',
        },
        swellStart + motionSpec.swell * 0.1,
      )
      .to(
        whiteTipSeams,
        {
          autoAlpha: 0.62,
          duration: motionSpec.swell * 0.24,
          strokeDashoffset: 0,
          stagger: 0.025,
          ease: 'power1.out',
        },
        swellStart + motionSpec.swell * 0.66,
      )
      .to(
        petalShapes,
        {
          autoAlpha: 0.36,
          duration: motionSpec.swell * 0.18,
          stagger: motionSpec.step * 0.22,
          ease: 'power1.out',
        },
        swellStart + motionSpec.swell * 0.76,
      )
      .to(
        budGlint,
        { autoAlpha: 0.78, duration: motionSpec.swell * 0.38 },
        swellStart + motionSpec.swell * 0.32,
      )
      .to(
        petalShapes,
        {
          autoAlpha: 1,
          duration: Math.max(0.035, motionSpec.burst * 0.24),
          stagger: motionSpec.step * 0.38,
          ease: 'power1.out',
        },
        burstStart,
      )
      .to(
        head,
        {
          duration: motionSpec.burst * 1.9,
          attr: { transform: headTransform(0.965, motionSpec.sway * 0.9) },
          ease: 'power3.out',
        },
        burstStart,
      )
      .to(
        budCore,
        {
          autoAlpha: 0.18,
          duration: motionSpec.burst * 2.05,
          scale: 0.68,
          y: 0.8,
          ease: 'power2.out',
        },
        burstStart + motionSpec.burst * 0.32,
      )
      .to(
        whiteTipCap,
        {
          autoAlpha: 0,
          duration: motionSpec.burst * 1.65,
          scale: whiteTipPeakScale * 1.03,
          y: -0.45,
          ease: 'power2.out',
        },
        burstStart + motionSpec.burst * 0.42,
      )
      .to(
        whiteTipSeams,
        {
          autoAlpha: 0,
          duration: motionSpec.burst * 0.9,
          ease: 'power1.out',
        },
        burstStart + motionSpec.burst * 0.3,
      )
      .to(
        budGlint,
        { autoAlpha: 0, duration: motionSpec.burst * 1.1, ease: 'power1.out' },
        burstStart + motionSpec.burst * 0.38,
      )
      .to(
        sepals,
        {
          duration: motionSpec.burst * 2.35,
          scale: 1.12,
          rotation: motionSpec.budTurn * -0.28,
          ease: 'power2.out',
        },
        burstStart + motionSpec.burst * 0.18,
      )
      .to(
        head,
        {
          duration: motionSpec.relax * 0.82,
          attr: { transform: headTransform(1, motionSpec.sway) },
          ease: 'power2.inOut',
        },
        burstStart + motionSpec.burst * 1.55,
      )
      .to(
        folds,
        {
          autoAlpha: 0.46,
          duration: motionSpec.relax * 0.82,
          scaleY: 1,
          stagger: 0.035,
          ease: 'power2.out',
        },
        burstStart + motionSpec.burst * 1.25,
      )
      .to(
        clefts,
        {
          autoAlpha: 0.48,
          duration: motionSpec.relax * 0.42,
          strokeDashoffset: 0,
          stagger: 0.03,
          ease: 'power2.out',
        },
        burstStart + motionSpec.burst * 1.52,
      )
      .to(
        veins,
        {
          autoAlpha: 0.34,
          duration: motionSpec.relax * 0.74,
          strokeDashoffset: 0,
          stagger: 0.04,
          ease: 'power1.out',
        },
        burstStart + motionSpec.burst * 1.68,
      )
      .to(
        hearts,
        {
          autoAlpha: 1,
          duration: motionSpec.relax * 0.44,
          scale: 1,
          ease: 'power2.out',
        },
        burstStart + motionSpec.burst * 1.45,
      );

    reproductivePairs.forEach((pair, pairIndex) => {
      const reproductiveStem = requiredElement<SVGPathElement>(
        pair,
        '.stamen-filament, .pistil-style',
      );
      const reproductiveTip = requiredElement<SVGCircleElement>(
        pair,
        '.stamen-anther, .pistil-tip',
      );
      const growthStart =
        burstStart + motionSpec.burst * 1.82 + pairIndex * motionSpec.step * 0.42;
      const growthDuration = motionSpec.relax * (pair.classList.contains('pistil') ? 0.54 : 0.48);

      growthTimeline
        .to(
          reproductiveStem,
          {
            duration: growthDuration,
            strokeDashoffset: 0,
            ease: 'power1.out',
          },
          growthStart,
        )
        .to(
          reproductiveTip,
          {
            autoAlpha: 1,
            duration: motionSpec.relax * 0.16,
            ease: 'power1.out',
          },
          growthStart + growthDuration,
        );
    });

    petalWraps.forEach((wrap) => {
      const release = burstStart + Number(requiredData(wrap, 'release'));
      const duration = Number(requiredData(wrap, 'duration')) * 1.06;
      const cupDuration = motionSpec.burst * 1.82;
      const relaxationStart = release + cupDuration * 0.88;
      const shapes = gsap.utils.toArray<SVGPathElement>('.petal-shape', wrap);

      growthTimeline.to(
        wrap,
        {
          attr: { transform: requiredData(wrap, 'burstTransform') },
          duration: cupDuration,
          ease: 'power3.out',
        },
        release,
      );

      shapes.forEach((shape) => {
        growthTimeline.to(
          shape,
          {
            duration: cupDuration,
            morphSVG: { shape: requiredData(shape, 'burst'), shapeIndex: 0 },
            ease: 'power3.out',
          },
          release,
        );

        growthTimeline.to(
          shape,
          {
            duration,
            morphSVG: { shape: requiredData(shape, 'open'), shapeIndex: 0 },
            ease: 'power2.out',
          },
          relaxationStart,
        );
      });

      growthTimeline.to(
        wrap,
        {
          attr: { transform: requiredData(wrap, 'openTransform') },
          duration,
          ease: 'power2.out',
        },
        relaxationStart,
      );
    });
  });

  if (copyMoments.length >= 3) {
    growthTimeline
      .to(copyMoments[0], { autoAlpha: 0, duration: 0.2, filter: 'blur(3px)', y: -26 }, 2.55)
      .to(copyMoments[1], { autoAlpha: 1, duration: 0.2, filter: 'blur(0px)', y: 0 }, 2.66)
      .to(copyMoments[1], { autoAlpha: 0, duration: 0.2, filter: 'blur(3px)', y: -26 }, 5.72)
      .to(copyMoments[2], { autoAlpha: 1, duration: 0.2, filter: 'blur(0px)', y: 0 }, 5.83);
  }

  /* Keeps the timeline's full length even when there is no copy to cross-fade. */
  growthTimeline.to({ value: 0 }, { duration: 0.9, value: 1 }, 7.18);

  const updateScene = () => {
    const progress = growthTimeline.progress();
    const bloom = gsap.utils.clamp(0, 1, (progress - 0.06) / 0.79);
    const active = progress < 0.34 ? 0 : progress < 0.74 ? 1 : 2;

    scene.style.setProperty('--bloom', bloom.toFixed(3));

    copyMoments.forEach((moment, index) => {
      moment.setAttribute('aria-hidden', String(index !== active));
    });
  };

  growthTimeline.eventCallback('onUpdate', updateScene);
  updateScene();

  return growthTimeline;
}

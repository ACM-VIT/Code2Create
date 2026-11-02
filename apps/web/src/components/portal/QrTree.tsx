import { toQR } from "toqr";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useReducedMotion } from "../dashboard/useReducedMotion";

export type TreeSeason = "spring" | "summer" | "autumn";

type Vec = readonly [number, number, number];
type Segment = { a: Vec; b: Vec; radius: number };
type Leaf = { at: Vec; radius: number; tone: number };
type Tuft = { at: Vec; height: number; lean: number; phase: number };
type Petal = { x: number; y: number; z: number; vx: number; vy: number; vz: number; spin: number; tone: number; life: number };
type Scene = { segments: Segment[]; leaves: Leaf[]; tufts: Tuft[]; canopyTop: number };

type Palette = {
  paper: string;
  ink: string;
  top: string;
  left: string;
  right: string;
  bark: string;
  barkLight: string;
  leaves: readonly string[];
  grass: string;
};

const palettes: Record<TreeSeason, Palette> = {
  spring: {
    paper: "#f1eee8",
    ink: "#0a0a09",
    top: "#2a0e18",
    left: "#3a1522",
    right: "#1a0810",
    bark: "#3a1522",
    barkLight: "#5a2536",
    leaves: ["#feb4cb", "#e3a9bf", "#d884a2", "#fbd0dd"],
    grass: "#8fb98f",
  },
  summer: {
    paper: "#f1eee8",
    ink: "#0a0a09",
    top: "#1f2a1a",
    left: "#2c3a25",
    right: "#131a10",
    bark: "#3d2b1f",
    barkLight: "#5b4130",
    leaves: ["#7fc38a", "#4f9d63", "#a8d8a0", "#5fb06f"],
    grass: "#6fae74",
  },
  autumn: {
    paper: "#f1eee8",
    ink: "#0a0a09",
    top: "#2a1a0e",
    left: "#3a2415",
    right: "#1a0f08",
    bark: "#3d2b1f",
    barkLight: "#5b4130",
    leaves: ["#f0b35a", "#d98634", "#e8c97a", "#c65f2c"],
    grass: "#b9a25a",
  },
};

const quietZone = 2;
const blockHeight = 0.62;
const isoPitch = Math.atan(Math.SQRT1_2);
const maxPetals = 48;

function qrModules(value: string) {
  const bits = toQR(value);
  const side = Math.round(Math.sqrt(bits.length));
  const dark: boolean[] = Array.from(bits, (bit) => bit === 1);
  return { side, dark };
}

/** The same code always grows the same tree. */
function seeded(text: string) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let state = h >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) % 100000) / 100000;
  };
}

/** How the code shapes its tree: denser codes grow taller and bushier, busier edges spread wider. */
function treeRecipe(modules: { side: number; dark: boolean[] }) {
  const { side, dark } = modules;
  let darkCount = 0;
  let edges = 0;
  for (let y = 0; y < side; y += 1) {
    for (let x = 0; x < side; x += 1) {
      const here = dark[y * side + x];
      if (here) darkCount += 1;
      if (x + 1 < side && here !== dark[y * side + x + 1]) edges += 1;
      if (y + 1 < side && here !== dark[(y + 1) * side + x]) edges += 1;
    }
  }
  const density = darkCount / (side * side);
  const edgeRatio = edges / (2 * side * (side - 1));
  const scale = side + quietZone * 2;
  return {
    density,
    edgeRatio,
    trunkHeight: (0.26 + 0.08 * density) * scale,
    trunkRadius: (0.024 + 0.008 * density) * scale,
    trunkLean: (0.04 + 0.03 * edgeRatio) * scale,
    mainBranches: 4 + Math.floor(4 * density),
    branchSpread: 0.5 + 0.5 * edgeRatio,
    branchLengthScale: 0.55 + 0.25 * density,
    maxDepth: edgeRatio > 0.28 ? 5 : 4,
    canopyDensity: 0.5 + 0.5 * density,
  };
}

function growScene(modules: { side: number; dark: boolean[] }, value: string): Scene {
  const random = seeded(value);
  const recipe = treeRecipe(modules);
  const extent = modules.side + quietZone * 2;
  const centre = extent / 2;
  const segments: Segment[] = [];
  const leaves: Leaf[] = [];
  const tufts: Tuft[] = [];
  let canopyTop = 0;

  // A tapered trunk in ten pieces, leaning and swaying.
  const trunkPoint = (t: number): Vec => [
    centre + recipe.trunkLean * t * t + 0.3 * recipe.trunkLean * Math.sin(t * Math.PI * 1.5),
    centre + 0.5 * recipe.trunkLean * Math.sin(t * Math.PI * 0.8),
    t * recipe.trunkHeight,
  ];
  for (let i = 0; i < 10; i += 1) {
    const t0 = i / 10;
    const t1 = (i + 1) / 10;
    segments.push({
      a: trunkPoint(t0),
      b: trunkPoint(t1),
      radius: recipe.trunkRadius * (1 - 0.55 * t0) * (1 + 0.08 * Math.sin(t0 * Math.PI * 0.8)),
    });
  }

  const grow = (from: Vec, yaw: number, pitch: number, length: number, radius: number, depth: number) => {
    const to: Vec = [
      from[0] + Math.cos(yaw) * Math.cos(pitch) * length,
      from[1] + Math.sin(yaw) * Math.cos(pitch) * length,
      from[2] + Math.sin(pitch) * length,
    ];
    segments.push({ a: from, b: to, radius });
    canopyTop = Math.max(canopyTop, to[2]);
    if (depth === 0) {
      const count = 2 + Math.floor(random() * 3 * recipe.canopyDensity);
      for (let i = 0; i < count; i += 1) {
        leaves.push({
          at: [to[0] + (random() - 0.5) * 1.8, to[1] + (random() - 0.5) * 1.8, to[2] + (random() - 0.3) * 1.5],
          radius: 0.4 + random() * 0.5,
          tone: Math.floor(random() * 4),
        });
      }
      return;
    }
    const children = 2 + (random() < recipe.canopyDensity - 0.3 ? 1 : 0);
    for (let i = 0; i < children; i += 1) {
      const spread = recipe.branchSpread * (0.7 + random() * 0.6);
      const childYaw = yaw + (i - (children - 1) / 2) * spread + (random() - 0.5) * 0.5;
      const childPitch = Math.max(0.3, pitch - 0.22 - random() * 0.4);
      grow(to, childYaw, childPitch, length * recipe.branchLengthScale * (0.95 + random() * 0.25), radius * 0.62, depth - 1);
    }
    if (depth <= 2 && random() < recipe.canopyDensity) {
      leaves.push({ at: to, radius: 0.35 + random() * 0.3, tone: Math.floor(random() * 4) });
    }
  };

  const crown = trunkPoint(1);
  for (let i = 0; i < recipe.mainBranches; i += 1) {
    const yaw = (i / recipe.mainBranches) * Math.PI * 2 + random() * 0.8;
    grow(crown, yaw, 0.85 + random() * 0.4, recipe.trunkHeight * 0.5, recipe.trunkRadius * 0.7, recipe.maxDepth - 1);
  }

  // Grass sprouts where a raised block meets open ground.
  for (let y = 0; y < modules.side; y += 1) {
    for (let x = 0; x < modules.side; x += 1) {
      if (!modules.dark[y * modules.side + x]) continue;
      const openBelow = y + 1 >= modules.side || !modules.dark[(y + 1) * modules.side + x];
      const openRight = x + 1 >= modules.side || !modules.dark[y * modules.side + x + 1];
      if (!openBelow && !openRight) continue;
      if (random() > 0.12) continue;
      tufts.push({
        at: [x + quietZone + (openRight ? 1 : random()), y + quietZone + (openBelow ? 1 : random()), 0],
        height: 0.5 + random() * 0.6,
        lean: (random() - 0.5) * 0.5,
        phase: random() * Math.PI * 2,
      });
    }
  }
  return { segments, leaves, tufts, canopyTop };
}

function ease(t: number) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function mix(from: string, to: string, t: number) {
  const parse = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const a = parse(from);
  const b = parse(to);
  const channel = (i: number) => Math.round((a[i] ?? 0) + ((b[i] ?? 0) - (a[i] ?? 0)) * t);
  return `rgb(${channel(0)} ${channel(1)} ${channel(2)})`;
}

type Frame = {
  context: CanvasRenderingContext2D;
  size: number;
  modules: { side: number; dark: boolean[] };
  scene: Scene;
  palette: Palette;
  progress: number;
  time: number;
  petals: Petal[];
};

function draw({ context, size, modules, scene, palette, progress, time, petals }: Frame) {
  const p = ease(progress);
  const extent = modules.side + quietZone * 2;
  const half = extent / 2;
  const breathe = 1 - p;
  const yaw = (Math.PI / 4) * (1 - p) + 0.035 * Math.sin(time * 0.35) * breathe;
  const pitch = isoPitch + (Math.PI / 2 - isoPitch) * p + 0.012 * Math.sin(time * 0.5) * breathe;
  const cosYaw = Math.cos(yaw);
  const sinYaw = Math.sin(yaw);
  const sinPitch = Math.sin(pitch);
  const cosPitch = Math.cos(pitch);
  const project = (v: Vec): [number, number] => {
    const x = v[0] - half;
    const y = v[1] - half;
    return [x * cosYaw - y * sinYaw, (x * sinYaw + y * cosYaw) * sinPitch - v[2] * cosPitch];
  };
  const corners = [project([0, 0, 0]), project([extent, 0, 0]), project([0, extent, 0]), project([extent, extent, 0])];
  const minX = Math.min(...corners.map((c) => c[0]));
  const maxX = Math.max(...corners.map((c) => c[0]));
  const minY = Math.min(...corners.map((c) => c[1]));
  const maxY = Math.max(...corners.map((c) => c[1]));
  const skyline = minY - scene.canopyTop * cosPitch * 1.05;
  const scale = (size * 0.96) / Math.max(maxX - minX, maxY - skyline);
  const offsetX = size / 2 - ((minX + maxX) / 2) * scale;
  const offsetY = size / 2 - ((skyline + maxY) / 2) * scale;
  const toScreen = (v: Vec): [number, number] => {
    const [x, y] = project(v);
    return [offsetX + x * scale, offsetY + y * scale];
  };
  const polygon = (points: readonly Vec[], fill: string) => {
    context.beginPath();
    points.forEach((point, index) => {
      const [x, y] = toScreen(point);
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    context.closePath();
    context.fillStyle = fill;
    context.fill();
  };

  context.clearRect(0, 0, size, size);
  polygon([[0, 0, 0], [extent, 0, 0], [extent, extent, 0], [0, extent, 0]], palette.paper);

  const cells: { x: number; y: number; depth: number }[] = [];
  for (let y = 0; y < modules.side; y += 1) {
    for (let x = 0; x < modules.side; x += 1) {
      if (!modules.dark[y * modules.side + x]) continue;
      const gx = x + quietZone;
      const gy = y + quietZone;
      cells.push({ x: gx, y: gy, depth: (gx - half) * sinYaw + (gy - half) * cosYaw });
    }
  }
  if (p > 0.995) {
    // Flat: a softly rounded plate, then crisp squares on the pixel grid so a phone can read it.
    const unit = (size * 0.96) / extent;
    const origin = (size - unit * extent) / 2;
    context.clearRect(0, 0, size, size);
    context.fillStyle = palette.paper;
    context.beginPath();
    context.roundRect(origin, origin, unit * extent, unit * extent, unit * 1.5);
    context.fill();
    context.fillStyle = palette.ink;
    for (const cell of cells) {
      const x0 = Math.round(origin + cell.x * unit);
      const y0 = Math.round(origin + cell.y * unit);
      context.fillRect(x0, y0, Math.round(origin + (cell.x + 1) * unit) - x0, Math.round(origin + (cell.y + 1) * unit) - y0);
    }
    return;
  }
  cells.sort((left, right) => left.depth - right.depth);
  const h = blockHeight * (1 - p * 0.6);
  const topTone = mix(palette.top, palette.ink, p);
  for (const { x, y } of cells) {
    polygon([[x + 1, y, 0], [x + 1, y + 1, 0], [x + 1, y + 1, h], [x + 1, y, h]], palette.right);
    polygon([[x, y + 1, 0], [x + 1, y + 1, 0], [x + 1, y + 1, h], [x, y + 1, h]], palette.left);
    polygon([[x, y, h], [x + 1, y, h], [x + 1, y + 1, h], [x, y + 1, h]], topTone);
  }

  const alive = Math.max(0, 1 - p * 1.6);
  if (alive <= 0) return;
  context.globalAlpha = alive;
  context.lineCap = "round";

  for (const tuft of scene.tufts) {
    const sway = 0.18 * Math.sin(time * 1.6 + tuft.phase);
    const [ax, ay] = toScreen([tuft.at[0], tuft.at[1], h]);
    const [bx, by] = toScreen([tuft.at[0] + tuft.lean + sway, tuft.at[1] + sway * 0.4, h + tuft.height]);
    context.beginPath();
    context.moveTo(ax, ay);
    context.lineTo(bx, by);
    context.lineWidth = Math.max(0.8, scale * 0.12);
    context.strokeStyle = palette.grass;
    context.stroke();
  }

  // A soft shadow keeps the tree grounded.
  const [sx, sy] = toScreen([half, half, h]);
  const shadow = context.createRadialGradient(sx, sy, 0, sx, sy, scale * scene.canopyTop * 0.45);
  shadow.addColorStop(0, "rgba(0 0 0 / 0.22)");
  shadow.addColorStop(1, "rgba(0 0 0 / 0)");
  context.fillStyle = shadow;
  context.beginPath();
  context.ellipse(sx, sy, scale * scene.canopyTop * 0.45, scale * scene.canopyTop * 0.22 * sinPitch + 1, 0, 0, Math.PI * 2);
  context.fill();

  for (const segment of scene.segments) {
    const [ax, ay] = toScreen(segment.a);
    const [bx, by] = toScreen(segment.b);
    context.beginPath();
    context.moveTo(ax, ay);
    context.lineTo(bx, by);
    context.lineWidth = Math.max(1, segment.radius * scale * 2);
    context.strokeStyle = segment.radius > 0.25 ? palette.bark : palette.barkLight;
    context.stroke();
  }
  const sway = 0.08 * Math.sin(time * 0.9);
  for (const leaf of scene.leaves) {
    const [x, y] = toScreen([leaf.at[0] + sway * leaf.at[2] * 0.15, leaf.at[1], leaf.at[2]]);
    context.beginPath();
    context.arc(x, y, Math.max(1.2, leaf.radius * scale * 0.5), 0, Math.PI * 2);
    context.fillStyle = palette.leaves[leaf.tone] ?? palette.leaves[0] ?? palette.bark;
    context.fill();
  }
  for (const petal of petals) {
    if (petal.life <= 0) continue;
    const [x, y] = toScreen([petal.x, petal.y, petal.z]);
    context.save();
    context.translate(x, y);
    context.rotate(petal.spin);
    context.globalAlpha = alive * Math.min(1, petal.life);
    context.fillStyle = palette.leaves[petal.tone] ?? palette.leaves[0] ?? palette.bark;
    context.beginPath();
    context.ellipse(0, 0, Math.max(1, scale * 0.28), Math.max(0.7, scale * 0.17), 0, 0, Math.PI * 2);
    context.fill();
    context.restore();
  }
  context.globalAlpha = 1;
}

function spawnPetal(scene: Scene, random: () => number, burst: boolean): Petal | null {
  const leaf = scene.leaves[Math.floor(random() * scene.leaves.length)];
  if (!leaf) return null;
  const angle = random() * Math.PI * 2;
  const speed = burst ? 4 + random() * 4 : 0.2 + random() * 0.3;
  return {
    x: leaf.at[0],
    y: leaf.at[1],
    z: leaf.at[2],
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed,
    vz: burst ? 1.5 + random() * 2.5 : -0.2,
    spin: random() * Math.PI,
    tone: leaf.tone,
    life: 1,
  };
}

function stepPetals(petals: Petal[], scene: Scene, random: () => number, dt: number, time: number, burstAt: number) {
  const bursting = time - burstAt < 0.25;
  const wanted = bursting ? maxPetals : 10 + Math.floor(scene.leaves.length / 12);
  if (petals.length < wanted && random() < (bursting ? 1 : 0.08)) {
    const petal = spawnPetal(scene, random, bursting);
    if (petal) petals.push(petal);
  }
  for (const petal of petals) {
    petal.vz -= 6 * dt;
    petal.vz = Math.max(petal.vz, -2.2);
    petal.vx += Math.sin(time * 1.3 + petal.spin) * 0.9 * dt;
    petal.vy += Math.cos(time * 1.1 + petal.spin) * 0.6 * dt;
    petal.x += petal.vx * dt;
    petal.y += petal.vy * dt;
    petal.z += petal.vz * dt;
    petal.spin += dt * 2;
    if (petal.z <= blockHeight) {
      petal.z = blockHeight;
      petal.vx *= 0.6;
      petal.vy *= 0.6;
      petal.life -= dt * 0.8;
    }
  }
  for (let i = petals.length - 1; i >= 0; i -= 1) {
    const petal = petals[i];
    if (petal && petal.life <= 0) petals.splice(i, 1);
  }
}

export const QrTree = memo(function QrTree({
  value,
  size = 168,
  season = "spring",
  flat: controlledFlat,
  label,
  className = "",
}: {
  value: string;
  /** A square side in px, or "fill" to size to the parent (which must be positioned). */
  size?: number | "fill";
  season?: TreeSeason;
  /** When given, the parent decides whether the code is flat and handles the tap. */
  flat?: boolean;
  /** Names the code for assistive tech, e.g. "Team review code". */
  label: string;
  className?: string;
}) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const modules = useMemo(() => qrModules(value), [value]);
  const scene = useMemo(() => growScene(modules, value), [modules, value]);
  const [ownFlat, setOwnFlat] = useState(false);
  const flat = controlledFlat ?? ownFlat;
  const [measured, setMeasured] = useState(0);
  const side = typeof size === "number" ? size : measured;
  const progress = useRef(0);
  const burstAt = useRef(-10);
  const clockStart = useRef<number | null>(null);
  const petals = useRef<Petal[]>([]);
  const reducedMotion = useReducedMotion();
  const palette = palettes[season];

  const observer = useRef<ResizeObserver | null>(null);
  // A callback ref measures the frame the moment it exists, then follows resizes.
  const frameRef = useCallback((frame: HTMLDivElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!frame) return;
    const measure = () => setMeasured(Math.floor(Math.min(frame.clientWidth, frame.clientHeight)));
    measure();
    observer.current = new ResizeObserver(measure);
    observer.current.observe(frame);
  }, []);

  useEffect(() => {
    if (controlledFlat !== undefined) burstAt.current = (performance.now() - (clockStart.current ?? performance.now())) / 1000;
  }, [controlledFlat]);

  useEffect(() => {
    const element = canvas.current;
    if (!element || side === 0) return;
    const ratio = window.devicePixelRatio || 1;
    element.width = Math.round(side * ratio);
    element.height = Math.round(side * ratio);
    const context = element.getContext("2d");
    if (!context) return;
    const random = seeded(`${value}:petals`);
    const target = flat ? 1 : 0;
    clockStart.current ??= performance.now();
    const started = clockStart.current;
    let last = performance.now();
    let frame = 0;
    let visible = true;
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? true;
    });
    observer.observe(element);
    const paint = (time: number) => {
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      draw({ context, size: side, modules, scene, palette, progress: progress.current, time, petals: petals.current });
    };
    const step = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const time = (now - started) / 1000;
      const current = progress.current;
      const rate = reducedMotion ? 1 : dt / 0.7;
      progress.current = current < target ? Math.min(target, current + rate) : Math.max(target, current - rate);
      if (!reducedMotion && progress.current < 1) stepPetals(petals.current, scene, random, dt, time, burstAt.current);
      if (visible && !document.hidden) paint(time);
      const settled = progress.current === target && (reducedMotion || target === 1);
      if (!settled) frame = window.requestAnimationFrame(step);
    };
    paint(0);
    frame = window.requestAnimationFrame(step);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [flat, modules, scene, side, reducedMotion, palette, value]);

  const element = (
    <canvas
      ref={canvas}
      role="img"
      aria-label={flat ? label : `${label} as a blossom tree; tap to flatten it for scanning`}
      onClick={(event) => {
        if (controlledFlat !== undefined) return;
        event.stopPropagation();
        burstAt.current = (performance.now() - (clockStart.current ?? performance.now())) / 1000;
        setOwnFlat((value) => !value);
      }}
      style={{ width: side, height: side }}
      className={`${controlledFlat === undefined ? "cursor-pointer" : ""} ${className}`}
    />
  );
  if (typeof size === "number") return element;
  return (
    <div ref={frameRef} className="absolute inset-0 flex items-center justify-center">
      {element}
    </div>
  );
});

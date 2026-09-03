import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

import { CANOPY_POINTS } from "./canopyPoints.js";

/*
 * Sakura petals.
 *
 * One canvas for the whole page, fixed to the viewport. The petals the boughs
 * shed in the FAQ act are the same particles that land in the footer — there is
 * no per-section field and nothing is emitted at the footer's top edge, so the
 * fall carries straight across the boundary.
 *
 * Motion is integrated per frame: gravity toward a per-petal terminal velocity,
 * air drag, a flutter that also drives the tumble, and a wind field with gusts.
 * Nothing is ever spawned inside the frame, and every airborne petal carries a
 * lifetime, so none can end up hanging in mid-air.
 *
 * THE DRIFT
 * ---------
 * The drift is a height map — one depth per column — redrawn from that height
 * map every frame. It is deliberately NOT a baked bitmap that gets carved: a
 * bitmap and a height map drift apart the moment you cut into one of them,
 * which is what left voids hanging under the surface with nothing beneath them.
 * Drawing from the height map every frame makes the mass under the surface
 * solid by construction, so it cannot develop a hole.
 *
 * The map also slumps toward its neighbours each frame, the way a pile of
 * anything light does, so a disturbance heals into a smooth hollow rather than
 * leaving the straight cut edges a carve would.
 */

type Point = readonly [number, number];
type Color = readonly [number, number, number];
export type PetalMode = "none" | "canopy" | "drift" | "path" | "swirl";
type PetalKind = "fall" | "path" | "swirl";

export interface PetalFieldHandle {
  setMode(next: PetalMode): void;
  setPurge(kind: PetalKind, on: boolean): void;
  setIntensity(value: number): void;
  setFocus(x: number, y: number): void;
  setWind(value: number): void;
}

interface PetalsProps {
  trackSelector?: string | null;
  floorSelector?: string | null;
  fillSelector?: string | null;
  interactive?: boolean;
  max?: number;
}

interface Petal {
  dead: boolean;
  kind: PetalKind;
  size: number;
  angle: number;
  spin: number;
  flutter: number;
  phase: number;
  sway: number;
  terminal: number;
  alpha: number;
  swirl: number;
  refill: boolean;
  life: number;
  maxLife: number;
  sprite: HTMLCanvasElement;
  x: number;
  y: number;
  vx: number;
  vy: number;
  fade: number;
  offset: number;
  orbit: number;
  pace: number;
  t: number;
}

interface StepCanvas extends HTMLCanvasElement {
  __step?: (frames?: number) => void;
}

interface PetalFloor {
  rect: DOMRect;
  floorY: number;
  target: number;
}

const BASE: Color = [210, 105, 143];
const TAU = Math.PI * 2;
const GRAVITY = 0.055;
const DRAG = 0.986;
const BUCKETS = 190;

/* Roughly how long a cursor-made hollow takes to fill back in. */
const REFILL_SECONDS = 10;
const REFILL_PER_FRAME = 7;

/* How fast the pile slumps sideways. Higher settles quicker; too high and the
   drift starts behaving like a liquid. */
const SLUMP = 0.14;

/*
 * The route petals take through the timeline act, in fractions of the frame:
 * down the left edge, along the floor, and up the right. The phone layout —
 * and any screen too tall for the descent — takes the flat single pass across
 * the middle instead; the route always follows the layout, so the phone
 * arrangement (bonsai up top, day card along the bottom) is never crossed by
 * the wide route's floor run. Sampled into a polyline once per resize, with
 * arc length carried along it so petals travel at an even speed rather than
 * sprinting through the straights.
 */
/* Both routes begin and end well outside the frame, so neither the mouth nor
   the tail of the stream is ever on screen. */
/* The climb hugs the right side harder than it used to: the phase card sits
   inside this loop, and the old climb at ~0.63–0.71 cut into the card's right
   edge on tablet and small-laptop widths. */
const PATH_WIDE: readonly Point[] = [
  [-0.08, -0.1],
  [0.02, 0.14],
  [0.05, 0.3],
  [0.075, 0.62],
  [0.11, 0.8],
  [0.2, 0.87],
  [0.34, 0.885],
  [0.46, 0.885],
  [0.6, 0.86],
  [0.7, 0.72],
  [0.73, 0.45],
  [0.77, 0.24],
  [0.84, 0.16],
  [0.9, 0.14],
  [1.08, 0.13],
];
const PATH_NARROW: readonly Point[] = [
  [-0.12, 0.61],
  [0.2, 0.585],
  [0.5, 0.58],
  [0.8, 0.585],
  [1.12, 0.61],
];

function rand(min: number, max: number) {
  return min + Math.random() * (max - min);
}

/*
 * Pre-rendered petal bitmaps, one per quantized tint. Filling the petal's
 * bezier outline petal by petal was the field's main per-frame draw cost;
 * a sprite blit is the same picture for a fraction of it. Twelve tints
 * cover the old continuous rand(-26, 30) shift more finely than the eye
 * reads at these sizes, and the flutter's squish still happens live, as an
 * x-scale on the blit. Supersampled at 32px and drawn down to 6–13.
 */
const SPRITE_TINTS = 12;
const SPRITE_BOX = 32;
const SPRITE_PAD = 2;
const SPRITE_SCALE = (SPRITE_BOX + SPRITE_PAD * 2) / SPRITE_BOX;
let sprites: HTMLCanvasElement[] | null = null;

const buildSprites = () =>
  Array.from({ length: SPRITE_TINTS }, (_, i) => {
    const shift = -26 + (56 * i) / (SPRITE_TINTS - 1);
    const s = SPRITE_BOX;
    const c = document.createElement("canvas");
    c.width = SPRITE_BOX + SPRITE_PAD * 2;
    c.height = c.width;
    const g = c.getContext("2d");
    if (!g) throw new Error("The browser could not create the petal sprite canvas.");
    g.translate(c.width / 2, c.height / 2);
    g.fillStyle = `rgb(${BASE[0] + shift * 0.5}, ${BASE[1] + shift}, ${BASE[2] + shift * 0.7})`;
    g.beginPath();
    g.moveTo(0, -s * 0.5);
    g.bezierCurveTo(s * 0.5, -s * 0.42, s * 0.46, s * 0.3, 0, s * 0.5);
    g.bezierCurveTo(-s * 0.46, s * 0.3, -s * 0.5, -s * 0.42, 0, -s * 0.5);
    g.fill();
    return c;
  });

function drawPetal(ctx: CanvasRenderingContext2D, p: Petal) {
  const w = p.size * SPRITE_SCALE * (Math.cos(p.phase) * 0.34 + 0.66);
  const h = p.size * SPRITE_SCALE;
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(p.angle);
  ctx.globalAlpha = p.alpha;
  ctx.drawImage(p.sprite, -w / 2, -h / 2, w, h);
  ctx.restore();
}

const Petals = forwardRef<PetalFieldHandle, PetalsProps>(function Petals(
  {
    trackSelector = null,
    floorSelector = null,
    fillSelector = null,
    interactive = false,
    max = 420,
  },
  ref,
) {
  const canvasRef = useRef<StepCanvas>(null);
  const cfg = useRef<{
    mode: PetalMode;
    intensity: number;
    focus: Point;
    wind: number;
    purge: Set<PetalKind>;
  }>({
    mode: "none",
    intensity: 0,
    focus: [0.5, 0.5],
    wind: 0,
    purge: new Set(),
  });

  useImperativeHandle(ref, () => ({
    setMode(next) {
      cfg.current.mode = next;
    },
    /* While a kind is purged, petals born to it die fast instead of taking
       their natural fall — the canvas paints over every act, so this is how
       the timeline's routed river is kept off the FAQ act entirely. */
    setPurge(kind, on) {
      if (on) cfg.current.purge.add(kind);
      else cfg.current.purge.delete(kind);
    },
    setIntensity(value) {
      cfg.current.intensity = Math.max(0, Math.min(1, value));
    },
    setFocus(x, y) {
      cfg.current.focus = [x, y];
    },
    setWind(value) {
      cfg.current.wind = value;
    },
  }));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) throw new Error("The petal canvas did not mount.");
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("The browser could not create the petal canvas.");
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const MAX = reduced ? 0 : max;
    if (!sprites) sprites = buildSprites();
    const availableSprites = sprites;

    const petals: Petal[] = Array.from({ length: MAX }, (_, index) => ({
      dead: true,
      kind: "fall",
      size: 0,
      angle: 0,
      spin: 0,
      flutter: 0,
      phase: 0,
      sway: 0,
      terminal: 0,
      alpha: 0,
      swirl: 0,
      refill: false,
      life: 0,
      maxLife: 0,
      sprite: availableSprites[index % availableSprites.length],
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      fade: 0,
      offset: 0,
      orbit: 0,
      pace: 0,
      t: 0,
    }));
    let w = 0;
    let h = 0;

    /* The drift: depth of the pile per column, in px. */
    const bank = new Float32Array(BUCKETS);
    const slumped = new Float32Array(BUCKETS);
    let bedWidth = 0;
    let bedSeeded = false;

    /* Fixed per-column jitter so the crest keeps its shape frame to frame
       instead of boiling. */
    const crest = Float32Array.from({ length: BUCKETS }, () => Math.random());

    /* The timeline route, resampled at even arc length for the current frame. */
    let route: Point[] = [];
    let routeCum = new Float64Array();
    let routeLength = 0;

    const buildRoute = () => {
      /* The same breakpoint the CSS re-blocks the phone layout at. */
      const wide = !(w <= 760 || h > w * 1.15);

      /*
       * The route is viewport fractions, but the navbar is a fixed pixel band —
       * on short screens the wide route's high run along the top lands right
       * behind the translucent pill. Clamp every on-screen control point below
       * the navbar, with room for the stream's lateral spread and wobble, so
       * the ribbon rides under the header instead of through it. The first
       * point stays where it is: it is off screen above, and is what keeps the
       * mouth of the stream out of frame.
       */
      const nav = document.querySelector<HTMLElement>(".navbar");
      const navBottom = nav ? nav.getBoundingClientRect().bottom : h * 0.1;
      const spread = Math.min(w, h) * 0.055 + 9;
      const clearFraction = Math.min(0.45, (navBottom + spread + 48) / h);
      const source: readonly Point[] = (wide ? PATH_WIDE : PATH_NARROW).map((pt, i): Point =>
        i === 0 ? pt : [pt[0], Math.max(pt[1], clearFraction)],
      );

      /* Catmull-Rom through the control points, so the corners are curves. */
      const pts: Point[] = [];
      for (let i = 0; i < source.length - 1; i += 1) {
        const p0 = source[Math.max(0, i - 1)];
        const p1 = source[i];
        const p2 = source[i + 1];
        const p3 = source[Math.min(source.length - 1, i + 2)];
        for (let k = 0; k < 12; k += 1) {
          const t = k / 12;
          const t2 = t * t;
          const t3 = t2 * t;
          pts.push([
            0.5 *
              (2 * p1[0] +
                (-p0[0] + p2[0]) * t +
                (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 +
                (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3) *
              w,
            0.5 *
              (2 * p1[1] +
                (-p0[1] + p2[1]) * t +
                (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 +
                (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3) *
              h,
          ]);
        }
      }
      pts.push([source[source.length - 1][0] * w, source[source.length - 1][1] * h]);

      route = pts;
      /* Cumulative arc length per point, so a lookup is a bisect rather than
         a walk — this runs for every routed petal on every frame. */
      routeCum = new Float64Array(route.length);
      for (let i = 1; i < route.length; i += 1) {
        routeCum[i] =
          routeCum[i - 1] +
          Math.hypot(route[i][0] - route[i - 1][0], route[i][1] - route[i - 1][1]);
      }
      routeLength = routeCum[route.length - 1] || 0;
    };

    /** Point and heading a fraction `t` along the route. */
    const alongRoute = (t: number) => {
      const target = Math.max(0, Math.min(1, t)) * routeLength;
      let lo = 1;
      let hi = route.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (routeCum[mid] < target) lo = mid + 1;
        else hi = mid;
      }
      const a = route[lo - 1];
      const b = route[lo];
      if (a === undefined || b === undefined) {
        const last = route[route.length - 1] ?? [0, 0];
        return { x: last[0], y: last[1], dx: 1, dy: 0 };
      }
      const seg = routeCum[lo] - routeCum[lo - 1] || 1;
      const f = (target - routeCum[lo - 1]) / seg;
      return {
        x: a[0] + (b[0] - a[0]) * f,
        y: a[1] + (b[1] - a[1]) * f,
        dx: (b[0] - a[0]) / seg,
        dy: (b[1] - a[1]) / seg,
      };
    };

    /*
     * The drift is made of petals, not of a colour. Painting the body as a
     * filled shape turns it into a slab of pink goo, and painting every petal
     * individually every frame is thousands of draws. So: one tile of real
     * petals, built once and wrapped so it repeats seamlessly, used as the
     * fill for the height map's shape.
     */
    const TILE = 240;
    const tile = document.createElement("canvas");
    const tileCtx = tile.getContext("2d");
    if (!tileCtx) throw new Error("The browser could not create the petal texture canvas.");
    let pattern: CanvasPattern | null = null;

    const buildTile = (dpr: number) => {
      tile.width = TILE * dpr;
      tile.height = TILE * dpr;
      tileCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      tileCtx.clearRect(0, 0, TILE, TILE);

      /*
       * Packed, not scattered. A drift is petals all the way down, so the tile
       * is laid in two passes at well over full coverage: a darker bed first,
       * then a brighter layer over it. Overlap is the point — it is what stops
       * gaps opening under the surface — and since the tile is built once, the
       * density costs nothing per frame.
       */
      const pass = (count: number, minR: number, maxR: number, lo: Color, hi: Color) => {
        for (let n = 0; n < count; n += 1) {
          const px = Math.random() * TILE;
          const py = Math.random() * TILE;
          const rx = minR + Math.random() * (maxR - minR);
          const ry = rx * (0.58 + Math.random() * 0.24);
          const angle = Math.random() * TAU;
          const t = Math.random();
          const r = lo[0] + (hi[0] - lo[0]) * t;
          const g = lo[1] + (hi[1] - lo[1]) * t;
          const b = lo[2] + (hi[2] - lo[2]) * t;
          tileCtx.fillStyle = `rgb(${r | 0}, ${g | 0}, ${b | 0})`;
          tileCtx.globalAlpha = 0.85 + t * 0.15;

          /* Wrapped copies, so the tile repeats without a seam. */
          for (let ox = -1; ox <= 1; ox += 1) {
            for (let oy = -1; oy <= 1; oy += 1) {
              const x = px + ox * TILE;
              const y = py + oy * TILE;
              if (x < -14 || x > TILE + 14 || y < -14 || y > TILE + 14) continue;
              tileCtx.save();
              tileCtx.translate(x, y);
              tileCtx.rotate(angle);
              tileCtx.beginPath();
              tileCtx.ellipse(0, 0, rx, ry, 0, 0, TAU);
              tileCtx.fill();
              tileCtx.restore();
            }
          }
        }
      };

      pass(1500, 5.4, 8.6, [150, 66, 100], [188, 92, 128]);
      pass(1100, 4.2, 7.0, [198, 100, 136], [238, 150, 178]);

      pattern = ctx.createPattern(tile, "repeat");
      /* The tile is at device resolution; bring it back to CSS pixels. */
      if (pattern !== null) {
        pattern.setTransform(new DOMMatrix().scale(1 / dpr));
      }
    };

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = window.innerWidth;
      h = window.innerHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      buildTile(dpr);
      buildRoute();
      bedSeeded = false;
    };
    resize();
    window.addEventListener("resize", resize);

    const pointer = { x: -9999, y: -9999, px: -9999, py: -9999, on: false, holding: false };
    const setPointer = (x: number, y: number, on: boolean) => {
      pointer.px = pointer.x;
      pointer.py = pointer.y;
      pointer.x = x;
      pointer.y = y;
      pointer.on = on;
    };
    const onMove = (event: PointerEvent) => {
      setPointer(event.clientX, event.clientY, true);
    };
    const onLeave = () => {
      if (pointer.holding) return;
      pointer.on = false;
    };
    const onDown = (event: PointerEvent) => {
      pointer.holding = true;
      pointer.px = event.clientX;
      pointer.py = event.clientY;
      pointer.x = event.clientX;
      pointer.y = event.clientY;
      pointer.on = true;
      if (event.currentTarget instanceof HTMLElement) {
        event.currentTarget.setPointerCapture(event.pointerId);
      }
    };
    const onUp = () => {
      pointer.holding = false;
      pointer.on = false;
    };
    const onTouchMove = (event: TouchEvent) => {
      if (!pointer.holding) return;
      event.preventDefault();
    };

    const floorHost =
      floorSelector !== null && floorSelector.length > 0
        ? document.querySelector<HTMLElement>(floorSelector)
        : null;
    const playEl = floorHost?.querySelector<HTMLElement>(".footer__play") ?? null;

    if (interactive) {
      window.addEventListener("pointermove", onMove, { passive: true });
      document.addEventListener("pointerleave", onLeave);
      if (playEl !== null) {
        playEl.addEventListener("pointerdown", onDown);
        playEl.addEventListener("pointerup", onUp);
        playEl.addEventListener("pointercancel", onUp);
        playEl.addEventListener("lostpointercapture", onUp);
        playEl.addEventListener("touchmove", onTouchMove, { passive: false });
      }
    }

    /** Where the drift lives right now, in viewport coordinates. */
    const readFloor = () => {
      const el =
        floorSelector !== null && floorSelector.length > 0
          ? document.querySelector<HTMLElement>(floorSelector)
          : null;
      if (el === null) return null;
      const rect = el.getBoundingClientRect();
      if (rect.bottom < -240 || rect.top > h + 240 || rect.width < 1) return null;

      bedWidth = rect.width;

      const fill =
        fillSelector !== null && fillSelector.length > 0
          ? document.querySelector<HTMLElement>(fillSelector)
          : null;
      /* Four fifths of the wordmark clears the drift; only its foot is
         buried. */
      let target = rect.height * 0.2;
      if (fill !== null) {
        const box = fill.getBoundingClientRect();
        target = Math.max(30, rect.bottom - (box.top + box.height * 0.8));
      }

      return { rect, floorY: rect.bottom, target: Math.min(target, rect.height * 0.55) };
    };

    const bucketAt = (localX: number) =>
      Math.max(0, Math.min(BUCKETS - 1, Math.floor((localX / bedWidth) * BUCKETS)));

    /**
     * Paint the drift from its height map: the solid body first — that is the
     * mass of petals, and drawing it as one shape is what makes voids
     * impossible — then loose petals along the crest so the surface reads as
     * petals rather than as a filled curve.
     */
    const drawBed = (floor: PetalFloor) => {
      const { left } = floor.rect;
      const base = floor.floorY;
      let peak = 0;
      for (let i = 0; i < BUCKETS; i += 1) peak = Math.max(peak, bank[i]);
      if (peak < 1 || !pattern) return;

      ctx.save();
      ctx.beginPath();
      ctx.moveTo(left, base + 4);
      for (let i = 0; i < BUCKETS; i += 1) {
        const x = left + ((i + 0.5) / BUCKETS) * bedWidth;
        ctx.lineTo(x, base - bank[i]);
      }
      ctx.lineTo(left + bedWidth, base + 4);
      ctx.closePath();
      ctx.clip();

      const top = base - peak - 8;
      const height = peak + 20;

      /* Every pixel of the mass is petal. */
      ctx.fillStyle = pattern;
      ctx.fillRect(left, top, bedWidth, height);

      /* Depth: the petals further down sit in their own shadow. */
      const shade = ctx.createLinearGradient(0, base - peak, 0, base + 4);
      shade.addColorStop(0, "rgba(58, 18, 38, 0)");
      shade.addColorStop(0.6, "rgba(58, 18, 38, 0.1)");
      shade.addColorStop(1, "rgba(44, 12, 30, 0.24)");
      ctx.fillStyle = shade;
      ctx.fillRect(left, top, bedWidth, height);
      ctx.restore();

      /* Loose petals over the crest, so the top edge is broken rather than
         cut, and the drift spills a little past its own outline. */
      for (let i = 0; i < BUCKETS; i += 1) {
        if (bank[i] < 2) continue;
        const x = left + ((i + 0.5) / BUCKETS) * bedWidth;
        const surface = base - bank[i];
        for (let k = 0; k < 3; k += 1) {
          const j = crest[(i + k * 43) % BUCKETS];
          const j2 = crest[(i * 7 + k * 17) % BUCKETS];
          ctx.save();
          ctx.translate(x + (j - 0.5) * 22, surface + j2 * 14 - 9);
          ctx.rotate(j2 * TAU);
          ctx.globalAlpha = 0.5 + j * 0.45;
          ctx.fillStyle = `rgb(${204 + j * 32}, ${104 + j * 46}, ${140 + j * 34})`;
          ctx.beginPath();
          ctx.ellipse(0, 0, 4.8 + j2 * 3, 3 + j2 * 2, 0, 0, TAU);
          ctx.fill();
          ctx.restore();
        }
      }
    };

    const reset = (p: Petal) => {
      /* Which act this petal belongs to. Petals born for one mode keep their
         plain-physics fall when the page has moved on to another, so a fast
         scroll across an act boundary hands the field over instead of
         teleporting stale petals onto the new route (NaN) or letting the
         overflow cull bleach the fresh ones. */
      p.kind = "fall";
      p.size = rand(7, 13);
      p.angle = rand(0, TAU);
      p.spin = rand(-0.55, 0.55) / 60;
      p.flutter = rand(0.01, 0.03);
      p.phase = rand(0, TAU);
      p.sway = rand(0.1, 0.42);
      p.terminal = rand(1.5, 3.1);
      p.alpha = rand(0.5, 0.95);
      p.swirl = 0;
      p.refill = false;
      p.life = 0;
      p.maxLife = rand(620, 1150);
      p.sprite = availableSprites[(Math.random() * availableSprites.length) | 0];
    };

    const spawn = (p: Petal, seeding: boolean) => {
      const { mode, wind } = cfg.current;
      reset(p);

      if (mode === "canopy") {
        const tree =
          trackSelector !== null && trackSelector.length > 0
            ? document.querySelector<HTMLElement>(trackSelector)
            : null;
        const box = tree?.getBoundingClientRect();
        const point = CANOPY_POINTS[(Math.random() * CANOPY_POINTS.length) | 0];

        if (box !== undefined && box.width > 0) {
          p.x = box.left + point[0] * box.width;
          p.y = box.top + point[1] * box.height;
        } else {
          p.x = rand(0, w * 0.5);
          p.y = rand(-h * 0.1, 0);
        }
        if (seeding) p.y += rand(0, h * 0.7);
        /* Off the canopy they drift down slowly — the quiet backdrop to the
           hero, not weather. */
        p.terminal *= 0.32;
        p.sway *= 0.6;
        p.vx = rand(-0.05, 0.15);
        p.vy = rand(0.1, 0.25);
        return;
      }

      if (mode === "path") {
        /* Strung out along the route, spread either side of it, and each with
           its own pace so they do not travel as one rigid column. Every spawn
           lands somewhere along the whole route — never queued at the mouth —
           so the stream is full from its first frame; latecomers fade in
           where they appear instead of popping. */
        p.kind = "path";
        p.t = rand(-0.02, 1.0);
        /* Kept tight: the ribbon's spread eats into the card's pocket on
           every side, so it stays narrower than the route's own margins. */
        p.offset = rand(-1, 1) * Math.min(w, h) * 0.055;
        p.pace = rand(0.000075, 0.00019);
        p.fade = rand(0.45, 0.9);
        p.alpha = seeding ? p.fade : 0;
        p.size = rand(6, 12);
        const at = alongRoute(p.t);
        p.x = at.x - at.dy * p.offset;
        p.y = at.y + at.dx * p.offset;
        p.vx = 0;
        p.vy = 0;
        p.maxLife = Infinity;
        return;
      }

      if (mode === "swirl") {
        p.kind = "swirl";
        const fromLeft = Math.random() < 0.5;
        p.x = fromLeft ? rand(-0.14, -0.02) * w : rand(1.02, 1.14) * w;
        p.y = rand(-0.05, 1.05) * h;
        /* Seeding scatters across the whole frame. Feeding only from the
           edges leaves the middle of the act empty. */
        if (seeding) {
          p.x = rand(-0.1, 1.1) * w;
          p.y = rand(-0.05, 1.05) * h;
        }
        p.vx = (fromLeft ? 1 : -1) * rand(0.5, 1.4);
        p.vy = rand(-0.3, 0.3);
        p.swirl = rand(0.45, 1.05) * (fromLeft ? 1 : -1);
        /* Each petal keeps to its own band of the vortex, so they spread over
           every radius instead of all being flung to the rim. */
        p.orbit = rand(0.08, 0.95);
        /* Long-lived: they are meant to circle the act, not cross it once. */
        p.maxLife = rand(1400, 2600);
        return;
      }

      const windy = Math.abs(wind) > 0.35;
      if (windy && Math.random() < 0.55) {
        p.x = wind > 0 ? rand(-0.16, -0.02) * w : rand(1.02, 1.16) * w;
        p.y = rand(-0.05, 0.85) * h;
      } else {
        p.x = rand(-0.08, 1.08) * w;
        p.y = rand(-0.22, -0.02) * h;
      }
      if (seeding) {
        p.x = rand(-0.08, 1.08) * w;
        p.y = rand(-0.15, 0.95) * h;
      }
      p.vx = wind * rand(0.4, 0.9);
      p.vy = rand(0.4, 1.1);
    };

    const free = () => {
      for (const petal of petals) {
        if (petal.dead) return petal;
      }
      return null;
    };

    let raf = 0;
    let seeded = false;
    let lastMode = cfg.current.mode;
    let clock = 0;
    let lastStamp = 0;

    const frame = () => {
      raf = requestAnimationFrame(frame);
      ctx.clearRect(0, 0, w, h);
      clock += 1;

      /* Wall-clock pacing for the routed stream: a scrub-heavy scroll frame
         (the bonsai act) drops rAF ticks, and per-frame advance would read as
         the river pausing. Scaled by real elapsed time it keeps its speed. */
      const now = performance.now();
      const dtScale = lastStamp ? Math.min(3.5, Math.max(0.5, (now - lastStamp) / 16.667)) : 1;
      lastStamp = now;

      const { mode, intensity, wind } = cfg.current;
      if (mode !== lastMode) {
        seeded = false;
        lastMode = mode;
      }

      const floor = readFloor();

      if (floor) {
        /* Lay the drift down in one go the first time its floor can be
           measured — the ground should be there when you arrive, not build
           itself while you watch. */
        if (!bedSeeded) {
          for (let i = 0; i < BUCKETS; i += 1) {
            /* Low-frequency undulation plus per-column jitter, so the crest
               has dunes in it rather than a ruled edge. */
            const dune = Math.sin(i * 0.07) * 0.06 + Math.sin(i * 0.021 + 1.7) * 0.05;
            bank[i] = floor.target * (0.86 + dune + crest[i] * 0.07);
          }
          bedSeeded = true;
        }

        /* Slump: each column pulls toward the mean of its neighbours, so a
           hollow heals into a smooth basin and no cut edge survives. */
        for (let i = 0; i < BUCKETS; i += 1) {
          const l = bank[i === 0 ? 0 : i - 1];
          const r = bank[i === BUCKETS - 1 ? BUCKETS - 1 : i + 1];
          slumped[i] = bank[i] + ((l + r) / 2 - bank[i]) * SLUMP;
        }
        bank.set(slumped);

        /* Sweeping the cursor through the drift throws the whole column above
           it into the air — not a pocket with petals left hanging over it. */
        if (interactive && pointer.on) {
          const localX = pointer.x - floor.rect.left;
          const moved = Math.hypot(pointer.x - pointer.px, pointer.y - pointer.py);

          if (localX > 0 && localX < bedWidth && moved > 1.5) {
            const bucket = bucketAt(localX);
            const depthAtCursor = Math.max(0, floor.floorY - pointer.y);

            if (pointer.y > floor.floorY - bank[bucket] - 30) {
              const reach = 62;
              const span = Math.ceil(reach / (bedWidth / BUCKETS));
              let displaced = 0;

              for (let i = bucket - span; i <= bucket + span; i += 1) {
                if (i < 0 || i >= BUCKETS) continue;
                const falloff = 1 - Math.abs(i - bucket) / (span + 1);
                const cutTo = depthAtCursor + (1 - falloff) * (bank[i] - depthAtCursor);
                if (cutTo < bank[i]) {
                  displaced += bank[i] - cutTo;
                  bank[i] = cutTo;
                }
              }

              /* Everything the columns gave up goes downwind. */
              const dx = pointer.x - pointer.px;
              const dy = pointer.y - pointer.py;
              const speed = Math.min(24, moved);
              const throwing = Math.min(18, Math.round(displaced / 10));
              for (let n = 0; n < throwing; n += 1) {
                const p = free();
                if (!p) break;
                p.dead = false;
                reset(p);
                p.x = pointer.x + rand(-reach, reach);
                p.y = pointer.y - Math.random() * 60;
                p.vx = (dx / (moved || 1)) * speed * rand(0.3, 0.9) + rand(-2.2, 2.2);
                p.vy = (dy / (moved || 1)) * speed * rand(0.2, 0.5) - rand(1.6, 5.5);
                p.spin = rand(-3.2, 3.2) / 60;
                p.maxLife = rand(180, 420);
              }
            }
            pointer.px = pointer.x;
            pointer.py = pointer.y;
          }
        }

        drawBed(floor);
      }

      const gust = wind * (1 + Math.sin(clock * 0.006) * 0.35 + Math.sin(clock * 0.021) * 0.12);
      const cap = mode === "swirl" ? 0.46 : 0.4;
      const want =
        mode === "none" ? 0 : Math.min(Math.round(MAX * intensity), Math.round(MAX * cap));
      let live = 0;

      const purge = cfg.current.purge;
      for (const p of petals) {
        if (p.dead) continue;
        if (!p.refill) live += 1;

        p.phase += p.flutter;
        p.angle += p.spin + p.vx * 0.004;
        p.life += 1;
        if (p.life > p.maxLife) {
          p.alpha *= 0.94;
          if (p.alpha < 0.04) {
            p.dead = true;
            continue;
          }
        }

        /* A purged kind dies in a couple of tenths, mid-motion, wherever it
           is — the fade below keeps the vanishing from reading as a pop. */
        if (purge.has(p.kind) && !p.refill) {
          p.alpha *= 0.74;
          if (p.alpha < 0.05) {
            p.dead = true;
            continue;
          }
        }

        if (mode === "path" && p.kind === "path" && !p.refill) {
          /* Carried along the route rather than falling. The drift either side
             of the line breathes, so the stream reads as loose petals on a
             current and not as beads on a wire. */
          if (!purge.has("path") && p.alpha < p.fade) {
            p.alpha = Math.min(p.fade, p.alpha + 0.035);
          }
          p.t += p.pace * dtScale;
          if (p.t > 1.03) {
            p.dead = true;
            continue;
          }
          const at = alongRoute(p.t);
          const wobble = Math.sin(p.phase * 1.7) * 9;
          const tx = at.x - at.dy * (p.offset + wobble);
          const ty = at.y + at.dx * (p.offset + wobble);
          /* Eased toward the target so a resize slides them over rather than
             teleporting the whole stream. */
          p.vx = (tx - p.x) * 0.08;
          p.vy = (ty - p.y) * 0.08;
          p.x += p.vx;
          p.y += p.vy;
          drawPetal(ctx, p);
          continue;
        }

        if (mode === "swirl" && p.kind === "swirl" && !p.refill) {
          const fx = cfg.current.focus[0] * w;
          const fy = cfg.current.focus[1] * h;
          const dx = fx - p.x;
          const dy = fy - p.y;
          const dist = Math.hypot(dx, dy) || 1;
          /* Unit vector pointing at the middle of the frame. */
          const ux = dx / dist;
          const uy = dy / dist;

          /* Tangential: what actually carries them round. */
          p.vx += -uy * p.swirl * 0.05;
          p.vy += ux * p.swirl * 0.05;

          /*
           * Radial: a *damped* spring onto this petal's own orbit. An
           * undamped one lets them overshoot outward, and because the
           * restoring force is weak out there they never come back — they
           * simply drift off the sides and die, which is why the middle of the
           * frame emptied out. Damping the radial velocity keeps each petal in
           * its band, and the bands are spread from near the centre to the rim
           * so the whole frame stays populated.
           */
          const reach = Math.min(w, h) * 0.62;
          const radialErr = dist - p.orbit * reach;
          const outward = -(p.vx * ux + p.vy * uy);
          const accel = radialErr * 0.0022 - outward * 0.08;
          p.vx += ux * accel;
          p.vy += uy * accel;

          /* Barely any weight in the swirl: they circle the frame rather than
             raining through it. */
          p.vy += GRAVITY * 0.12;
        } else {
          p.vy += (p.terminal - p.vy) * GRAVITY;
          p.vx += Math.sin(p.phase) * p.sway * 0.16;
        }

        if (!p.refill) p.vx += (gust - p.vx) * 0.012;
        p.vx *= DRAG;
        p.vy *= DRAG;

        p.x += p.vx;
        p.y += p.vy;

        /* Landing: the petal becomes depth in the column it fell into. */
        if (floor && p.x > floor.rect.left && p.x < floor.rect.right) {
          const bucket = bucketAt(p.x - floor.rect.left);
          if (p.y >= floor.floorY - bank[bucket]) {
            bank[bucket] = Math.min(floor.target, bank[bucket] + p.size * 0.5);
            p.dead = true;
            continue;
          }
        }

        /* Cull below the viewport, unless the drift's floor is further down
           still — otherwise a petal dies before it can ever land. */
        const cullY = floor ? Math.max(h + 60, floor.floorY + 40) : h + 60;
        if (p.y > cullY || p.x > w + 90 || p.x < -90) {
          p.dead = true;
        } else {
          drawPetal(ctx, p);
        }
      }

      /* Top the drift back up to the threshold and no further, so a full bed
         has nothing falling into it. Paced so a hollow closes over about
         REFILL_SECONDS rather than snapping shut. */
      let shortfall = 0;
      if (floor) {
        const low = [];
        for (let i = 0; i < BUCKETS; i += 1) {
          if (floor.target - bank[i] > 6) low.push(i);
        }
        shortfall = low.length;

        if (low.length) {
          let deficit = 0;
          for (const i of low) deficit += floor.target - bank[i];
          const perPetal = 10 * 0.5;
          const budget = Math.max(
            1,
            Math.min(REFILL_PER_FRAME, Math.ceil(deficit / perPetal / (REFILL_SECONDS * 60))),
          );

          for (let n = 0; n < budget; n += 1) {
            const bucket = low[(Math.random() * low.length) | 0];
            const p = free();
            if (!p) break;
            p.dead = false;
            reset(p);
            p.refill = true;
            p.x = floor.rect.left + ((bucket + Math.random()) / BUCKETS) * bedWidth;
            p.y = floor.floorY - bank[bucket] - rand(40, 130);
            p.vx = rand(-0.4, 0.4);
            p.vy = rand(1.6, 3);
            p.maxLife = 400;
          }
        }
      }

      /* Ambient fall, suppressed once the drift is full and the footer owns the
         viewport — nothing should be falling into a finished bed. */
      const footerOwnsView = floor !== null && floor.rect.top < h * 0.4;
      if (footerOwnsView && shortfall === 0) {
        seeded = true;
      } else if (live < want) {
        const budget = seeded ? 3 : want;
        for (let i = 0, made = 0; i < petals.length && made < budget; i += 1) {
          if (!petals[i].dead) continue;
          petals[i].dead = false;
          spawn(petals[i], !seeded);
          made += 1;
        }
        seeded = true;
      } else if (live > want + 8) {
        /* Thin out strangers from a previous act first; only when the field is
           being wound down to nothing does the fade take everyone, so a mode
           hand-off can never bleach the petals that were just seeded for it.
           Strangers die fast — the FAQ act must not open under the
           timeline's river — while a same-kind wind-down keeps some grace. */
        const takeAll = want === 0;
        for (const p of petals) {
          if (!p.dead && !p.refill && (takeAll || p.kind !== mode)) {
            p.alpha *= p.kind !== mode ? 0.88 : 0.965;
            if (p.alpha < 0.05) p.dead = true;
          }
        }
      }
    };

    if (MAX) raf = requestAnimationFrame(frame);

    /* Lets a test pump frames: the embedded preview reports the document
       hidden, so the browser never delivers rAF and the field is otherwise
       unobservable there. */
    if (import.meta.env.DEV) {
      canvas.__step = (n = 1) => {
        for (let i = 0; i < n; i += 1) {
          cancelAnimationFrame(raf);
          frame();
        }
        cancelAnimationFrame(raf);
      };
    }

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerleave", onLeave);
      if (playEl) {
        playEl.removeEventListener("pointerdown", onDown);
        playEl.removeEventListener("pointerup", onUp);
        playEl.removeEventListener("pointercancel", onUp);
        playEl.removeEventListener("lostpointercapture", onUp);
        playEl.removeEventListener("touchmove", onTouchMove);
      }
    };
  }, [max, interactive, trackSelector, floorSelector, fillSelector]);

  return <canvas ref={canvasRef} className="petals" aria-hidden="true" />;
});

export default Petals;

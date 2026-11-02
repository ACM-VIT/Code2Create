/* The submission bloom: Yash Raj Singh's generative branch of
   double-flowered pink blooms (25+ petals per bloom), played as a timed
   one-shot celebration.

   Everything here is generated: petal surfaces, whorl packing,
   the stem spline, the leaves. Nothing is loaded from a model.
   Loaded lazily; three.js only ships when a submission succeeds. */

import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";

type NumberProfile = readonly [number, number, ...number[]];

type PetalGeometryOptions = {
  widths: NumberProfile;
  length?: number;
  notch?: number;
  cup?: number;
  curl?: number;
  ruffle?: number;
  nu?: number;
  nv?: number;
  baseColor: THREE.ColorRepresentation;
  tipColor: THREE.ColorRepresentation;
  edgeColor: THREE.ColorRepresentation;
};

type PetalDescriptor = {
  az: number;
  qAz: THREE.Quaternion;
  pitchOpen: number;
  roll: number;
  twist: number;
  scale: number;
  radius: number;
  cue: number;
};

type BloomAnchor = {
  pos: THREE.Vector3;
  dir: THREE.Vector3;
  size: number;
};

type LeafAnchor = {
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  size: number;
  cue: number;
};

type Shot = {
  p: number;
  pos: readonly [number, number, number];
  look: readonly [number, number, number];
  fov: number;
  roll: number;
};

export type FlowerScene = {
  play(durationMs?: number): void;
  dispose(): void;
};

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const smooth = (t: number) => t * t * (3 - 2 * t);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Sample a monotonic t → value table with Catmull-Rom smoothing. */
function profile(table: NumberProfile, t: number) {
  const n = table.length - 1;
  const x = clamp(t, 0, 1) * n;
  const i = Math.min(n - 1, Math.floor(x));
  const f = x - i;
  const p0 = table[Math.max(0, i - 1)] ?? table[0];
  const p1 = table[i] ?? table[0];
  const p2 = table[i + 1] ?? table[table.length - 1] ?? table[0];
  const p3 = table[Math.min(n, i + 2)] ?? table[table.length - 1] ?? table[0];
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * f +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * f * f +
      (-p0 + 3 * p1 - 3 * p2 + p3) * f * f * f)
  );
}

/**
 * A lofted surface rather than a flat card: obovate outline with a
 * notch at the tip, cupped across its width, curled back along
 * its length, with a light ruffle on the free edge.
 */
function petalGeometry({
  widths,
  length = 1,
  notch = 0.15,
  cup = 0.62,
  curl = 0.3,
  ruffle = 0.032,
  nu = 18,
  nv = 24,
  baseColor,
  tipColor,
  edgeColor,
}: PetalGeometryOptions) {
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const c = new THREE.Color();
  const cBase = new THREE.Color(baseColor);
  const cTip = new THREE.Color(tipColor);
  const cEdge = new THREE.Color(edgeColor);

  for (let j = 0; j <= nv; j += 1) {
    const t = j / nv;
    const w = profile(widths, t);
    for (let i = 0; i <= nu; i += 1) {
      const s = (i / nu) * 2 - 1;

      const x = s * w;
      // the notch: the tip edge dips in the middle
      const yTop = 1 - notch * Math.exp(-(s * s) / 0.07);
      const y = t * yTop * length;

      let z = cup * x * x;
      z += curl * t * t * length;
      z += ruffle * Math.sin(s * 3.6) * Math.pow(t, 2.4) * Math.abs(s);

      pos.push(x, y, z);

      // pale at the tip, deep pink down at the throat, blush on the edge
      c.copy(cBase).lerp(cTip, smooth(clamp((t - 0.02) / 0.78, 0, 1)));
      c.lerp(cEdge, Math.pow(Math.abs(s), 2.4) * 0.42);
      col.push(c.r, c.g, c.b);
    }
  }

  for (let j = 0; j < nv; j += 1) {
    for (let i = 0; i < nu; i += 1) {
      const a = j * (nu + 1) + i;
      const b = a + 1;
      const d = a + nu + 1;
      const e = d + 1;
      idx.push(a, d, b, b, d, e);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/* petal: narrow throat, widest at ~70%, blunt notched tip */
const PETAL_W: NumberProfile = [0.05, 0.17, 0.31, 0.44, 0.53, 0.58, 0.57, 0.5, 0.4, 0.31];
/* leaf: lanceolate, pointed */
const LEAF_W: NumberProfile = [0.03, 0.13, 0.2, 0.24, 0.25, 0.23, 0.18, 0.12, 0.06, 0.015];

/**
 * Five whorls, each smaller and steeper than the last, each rotated
 * off the one below so no petal sits directly behind another. That
 * offset is what makes a double bloom read as full rather than layered.
 */
const WHORLS = [
  { count: 7, scale: 1.0, pitch: 13, offset: 0, radius: 0.11, roll: 0.05 },
  { count: 7, scale: 0.88, pitch: 29, offset: 26, radius: 0.09, roll: -0.05 },
  { count: 6, scale: 0.73, pitch: 45, offset: 55, radius: 0.07, roll: 0.07 },
  { count: 6, scale: 0.58, pitch: 60, offset: 18, radius: 0.05, roll: -0.07 },
  { count: 5, scale: 0.43, pitch: 73, offset: 44, radius: 0.03, roll: 0.06 },
  { count: 4, scale: 0.29, pitch: 84, offset: 12, radius: 0.015, roll: -0.05 },
] as const;

const PETALS_PER_BLOOM = WHORLS.reduce((n, w) => n + w.count, 0);

const DEG = Math.PI / 180;

/**
 * Petal descriptors rather than baked matrices — every petal carries the
 * pose it will hold when open, and the frame loop interpolates it out of
 * the bud. Outer whorls are given the earliest cue, so a bloom opens from
 * the outside in, the way a real one does.
 */
function whorlPetals(): PetalDescriptor[] {
  const out: PetalDescriptor[] = [];
  WHORLS.forEach((w, wi) => {
    for (let i = 0; i < w.count; i += 1) {
      const az = ((i / w.count) * 360 + w.offset + rand(-7, 7)) * DEG;
      out.push({
        az,
        qAz: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), az),
        pitchOpen: (w.pitch + rand(-6, 6)) * DEG,
        roll: w.roll + rand(-0.07, 0.07),
        twist: rand(0.45, 0.85) * (Math.random() < 0.5 ? -1 : 1),
        scale: w.scale * rand(0.9, 1.06),
        radius: w.radius,
        // outer ring first, then inward
        cue: 0.05 + wi * 0.042 + rand(0, 0.03),
      });
    }
  });
  return out;
}

/* a petal still in the bud stands almost parallel to the flower axis */
const PITCH_CLOSED = 94 * DEG;
const UNFURL = 0.2;

/**
 * One long arc across the frame plus a couple of side twigs. Bloom
 * anchors ride the arc; each carries an outward direction so the
 * flowers face the camera rather than the wood.
 */
function branch() {
  const spine = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-11.0, 7.6, -4.2),
    new THREE.Vector3(-6.4, 6.2, -1.8),
    new THREE.Vector3(-2.4, 4.9, 0.2),
    new THREE.Vector3(1.4, 3.9, 1.0),
    new THREE.Vector3(5.0, 2.6, 0.3),
    new THREE.Vector3(8.6, 0.6, -1.8),
    new THREE.Vector3(12.0, -2.6, -4.4),
  ]);

  const twigs = [
    new THREE.CatmullRomCurve3([
      spine.getPointAt(0.3),
      spine.getPointAt(0.3).add(new THREE.Vector3(0.6, 1.1, 0.7)),
      spine.getPointAt(0.3).add(new THREE.Vector3(1.5, 2.0, 1.4)),
    ]),
    new THREE.CatmullRomCurve3([
      spine.getPointAt(0.62),
      spine.getPointAt(0.62).add(new THREE.Vector3(0.4, -1.2, 0.9)),
      spine.getPointAt(0.62).add(new THREE.Vector3(1.2, -2.1, 1.7)),
    ]),
    new THREE.CatmullRomCurve3([
      spine.getPointAt(0.46),
      spine.getPointAt(0.46).add(new THREE.Vector3(-0.5, 1.3, 1.0)),
      spine.getPointAt(0.46).add(new THREE.Vector3(-1.1, 2.2, 1.9)),
    ]),
  ];

  const geoms: THREE.BufferGeometry[] = [];
  const tube = (curve: THREE.Curve<THREE.Vector3>, r0: number, r1: number, seg: number) => {
    const g = new THREE.TubeGeometry(curve, seg, 1, 9, false);
    const pa = g.getAttribute("position");
    const uv = g.getAttribute("uv");
    const center = new THREE.Vector3();
    const v = new THREE.Vector3();
    for (let i = 0; i < pa.count; i += 1) {
      const u = clamp(uv.getX(i), 0, 1);
      curve.getPointAt(u, center);
      const r = lerp(r0, r1, u);
      v.fromBufferAttribute(pa, i).sub(center).multiplyScalar(r);
      v.add(center);
      // a little knot and wobble so it is not a hose
      const knot = 1 + Math.sin(u * 34) * 0.05 + Math.sin(u * 11) * 0.04;
      v.sub(center).multiplyScalar(knot).add(center);
      pa.setXYZ(i, v.x, v.y, v.z);
    }
    g.computeVertexNormals();
    geoms.push(g);
  };

  tube(spine, 0.26, 0.11, 140);
  twigs.forEach((tw) => tube(tw, 0.07, 0.025, 40));

  /* bloom anchors along the spine and the twig tips */
  const blooms: BloomAnchor[] = [];
  const addBloom = (curve: THREE.Curve<THREE.Vector3>, u: number, size: number) => {
    const p = curve.getPointAt(clamp(u, 0, 1));
    const tan = curve.getTangentAt(clamp(u, 0, 1));
    // face out of the branch, toward the camera side
    const out = new THREE.Vector3(0, 0, 1)
      .cross(tan)
      .normalize()
      .multiplyScalar(rand(-0.5, 0.5))
      .add(new THREE.Vector3(rand(-0.35, 0.35), rand(0.15, 0.8), rand(1.1, 1.9)))
      .normalize();
    blooms.push({ pos: p.clone().addScaledVector(out, size * 0.55), dir: out, size });
  };

  addBloom(spine, 0.1, 1.0);
  addBloom(spine, 0.235, 1.5);
  addBloom(spine, 0.35, 1.12);
  addBloom(spine, 0.47, 1.95);
  addBloom(spine, 0.575, 1.25);
  addBloom(spine, 0.7, 2.25);
  addBloom(spine, 0.82, 1.45);
  addBloom(spine, 0.92, 1.05);
  const twigBloomSizes = [
    [1.2, 0.8],
    [1.5, 0.94],
    [1.1, 0.74],
  ] as const;
  twigs.forEach((tw, i) => {
    const sizes = twigBloomSizes[i];
    if (!sizes) return;
    addBloom(tw, 1, sizes[0]);
    addBloom(tw, 0.55, sizes[1]);
  });

  /* leaves cling to the wood between the flowers */
  const leaves: LeafAnchor[] = [];
  for (let i = 0; i < 16; i += 1) {
    const u = rand(0.08, 0.95);
    const p = spine.getPointAt(u);
    const tan = spine.getTangentAt(u);
    const q = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(rand(-1, 1), rand(-0.6, 1), rand(0.4, 1.4)).normalize(),
    );
    q.multiply(
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rand(0, Math.PI * 2)),
    );
    leaves.push({
      pos: p.clone().addScaledVector(tan, rand(-0.1, 0.1)),
      quat: q,
      size: rand(0.85, 1.5),
      cue: rand(0, 0.55),
    });
  }

  return { geoms, blooms, leaves, spine };
}

function mergeGeoms(geoms: readonly THREE.BufferGeometry[]) {
  let vc = 0;
  let ic = 0;
  geoms.forEach((g) => {
    vc += g.getAttribute("position").count;
    const index = g.getIndex();
    if (!index) throw new Error("Branch geometry is missing its index.");
    ic += index.count;
  });
  const pos = new Float32Array(vc * 3);
  const nrm = new Float32Array(vc * 3);
  const idx = new Uint32Array(ic);
  let vo = 0;
  let io = 0;
  geoms.forEach((g) => {
    const position = g.getAttribute("position");
    const normal = g.getAttribute("normal");
    const index = g.getIndex();
    if (!index) throw new Error("Branch geometry is missing its index.");
    pos.set(position.array, vo * 3);
    nrm.set(normal.array, vo * 3);
    const gi = index.array;
    for (let i = 0; i < gi.length; i += 1) {
      const vertexIndex = gi[i];
      if (vertexIndex === undefined) throw new Error("Branch geometry has an invalid index.");
      idx[io + i] = vertexIndex + vo;
    }
    vo += position.count;
    io += gi.length;
    g.dispose();
  });
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  out.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}

/**
 * A blocked or disabled WebGL context makes three.js log two console
 * errors and then throw when it builds the renderer. The caller already
 * treats a throw as "skip the bloom", but the two logs still reach error
 * tracking as separate issues. Probe on a throwaway canvas first and
 * throw our own error, so the skip path runs before three.js logs.
 *
 * Release the probe context right after the check: browsers cap the
 * number of live WebGL contexts, so a retained probe could starve the
 * renderer of the context it needs and trigger the same error.
 */
function assertWebGLAvailable() {
  const probe = document.createElement("canvas");
  const context = probe.getContext("webgl2") ?? probe.getContext("webgl");
  if (!context) {
    throw new Error("WebGL is unavailable; skipping the submission bloom.");
  }
  context.getExtension("WEBGL_lose_context")?.loseContext();
}

export function createFlowerScene(canvas: HTMLCanvasElement): FlowerScene {
  assertWebGLAvailable();

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const small = window.matchMedia("(max-width: 820px)").matches;

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, small ? 1.6 : 2));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.82;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0c0004);

  const camera = new THREE.PerspectiveCamera(34, window.innerWidth / window.innerHeight, 0.1, 200);

  /* --- environment: gives the petals something to be glossy about --- */
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.3;

  /* --- lights --- */
  const key = new THREE.DirectionalLight(0xfff2f6, 2.7);
  key.position.set(-5.5, 6.5, 9);
  scene.add(key);

  const rim = new THREE.DirectionalLight(0xff7fb0, 3.4);
  rim.position.set(6, -1.5, -7.5);
  scene.add(rim);

  const kick = new THREE.DirectionalLight(0xbcc8ff, 0.95);
  kick.position.set(9, 4, -2);
  scene.add(kick);

  scene.add(new THREE.AmbientLight(0x171320, 0.5));
  scene.add(new THREE.HemisphereLight(0x3a2430, 0x08080c, 0.85));

  const glow = new THREE.PointLight(0xffb8d2, 9, 12, 2);
  scene.add(glow);

  /* --- geometry --- */
  const group = new THREE.Group();
  scene.add(group);

  const { geoms, blooms, leaves } = branch();

  const wood = new THREE.Mesh(
    mergeGeoms(geoms),
    new THREE.MeshPhysicalMaterial({
      color: 0x211620,
      roughness: 0.74,
      envMapIntensity: 0.55,
      metalness: 0,
      clearcoat: 0.42,
      clearcoatRoughness: 0.5,
      sheen: 0.3,
      sheenColor: new THREE.Color(0x4d3742),
    }),
  );
  group.add(wood);

  const petalGeo = petalGeometry({
    widths: PETAL_W,
    baseColor: 0xc0416e,
    tipColor: 0xf7cfdf,
    edgeColor: 0xdd7fa8,
    nu: small ? 14 : 22,
    nv: small ? 18 : 30,
  });

  const petalMat = new THREE.MeshPhysicalMaterial({
    vertexColors: true,
    roughness: 0.4,
    metalness: 0,
    clearcoat: 0.6,
    clearcoatRoughness: 0.26,
    sheen: 1,
    sheenRoughness: 0.32,
    sheenColor: new THREE.Color(0xffc9dd),
    side: THREE.DoubleSide,
    iridescence: 0.14,
    iridescenceIOR: 1.2,
    envMapIntensity: 1.45,
  });

  const leafGeo = petalGeometry({
    widths: LEAF_W,
    notch: 0.02,
    cup: 0.3,
    curl: 0.2,
    ruffle: 0.09,
    baseColor: 0x0a1c11,
    tipColor: 0x14301e,
    edgeColor: 0x07130c,
    nu: 10,
    nv: 16,
  });

  const leafMat = new THREE.MeshPhysicalMaterial({
    vertexColors: true,
    roughness: 0.42,
    clearcoat: 0.6,
    clearcoatRoughness: 0.3,
    side: THREE.DoubleSide,
    envMapIntensity: 1.1,
  });

  /* blooms: one instanced mesh for every petal on the branch */
  const localPetals = blooms.map(() => whorlPetals());
  const petalMesh = new THREE.InstancedMesh(petalGeo, petalMat, blooms.length * PETALS_PER_BLOOM);
  petalMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  petalMesh.frustumCulled = false;
  group.add(petalMesh);

  const bloomState = blooms.map((b, i) => ({
    ...b,
    quat: new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.dir),
    phase: rand(0, 6.28),
    speed: rand(0.5, 1.1),
    // the wave of flowering travels along the branch
    cue: (i / blooms.length) * 0.42 + rand(0, 0.04),
  }));

  /* stamens: a gold-white tuft at the heart of each bloom */
  const stamenGeo = new THREE.CylinderGeometry(0.007, 0.013, 0.4, 4, 1, true);
  stamenGeo.translate(0, 0.2, 0);
  const stamenMat = new THREE.MeshStandardMaterial({
    color: 0xffe6b4,
    emissive: 0xffcf86,
    emissiveIntensity: 0.9,
    roughness: 0.5,
  });
  const STAMENS = 24;
  const stamenMesh = new THREE.InstancedMesh(stamenGeo, stamenMat, bloomState.length * STAMENS);
  stamenMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  stamenMesh.frustumCulled = false;
  group.add(stamenMesh);

  const localStamens = bloomState.map(() => {
    const arr = [];
    for (let i = 0; i < STAMENS; i += 1) {
      const az = rand(0, Math.PI * 2);
      const tilt = rand(0.1, 0.55);
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(tilt, az, 0, "YXZ"));
      const s = rand(0.7, 1.15);
      arr.push(
        new THREE.Matrix4().compose(new THREE.Vector3(0, 0.02, 0), q, new THREE.Vector3(s, s, s)),
      );
    }
    return arr;
  });

  const leafMesh = new THREE.InstancedMesh(leafGeo, leafMat, leaves.length);
  leafMesh.frustumCulled = false;
  group.add(leafMesh);

  /* --- post --- */
  let composer: EffectComposer | null = null;
  if (!small) {
    composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    composer.addPass(
      new UnrealBloomPass(
        new THREE.Vector2(window.innerWidth, window.innerHeight),
        0.3,
        0.75,
        0.92,
      ),
    );
  }

  /* --- camera: a single push through the branch --- */
  const shots: readonly [Shot, ...Shot[]] = [
    { p: 0.0, pos: [-0.9, 2.8, 16.2], look: [0.1, 4.2, 0], fov: 34, roll: 0 },
    { p: 0.42, pos: [-0.2, 3.2, 13.2], look: [0.7, 4.1, 0], fov: 34, roll: -0.01 },
    { p: 0.78, pos: [1.3, 4.1, 10.0], look: [1.7, 4.2, 0], fov: 37, roll: -0.02 },
    { p: 1.0, pos: [3.4, 7.0, 5.6], look: [2.4, 3.6, -0.4], fov: 42, roll: -0.05 },
  ];

  let portrait = window.innerHeight > window.innerWidth;

  const camPos = new THREE.Vector3(...shots[0].pos);
  const camLook = new THREE.Vector3(...shots[0].look);
  const tgtPos = camPos.clone();
  const tgtLook = camLook.clone();

  function sampleShot(t: number) {
    let a = shots[0];
    let b = shots[shots.length - 1] ?? shots[0];
    for (let i = 0; i < shots.length - 1; i += 1) {
      const current = shots[i];
      const next = shots[i + 1];
      if (current && next && t >= current.p && t <= next.p) {
        a = current;
        b = next;
        break;
      }
    }
    const k = smooth(clamp((t - a.p) / (b.p - a.p || 1), 0, 1));
    tgtPos.set(
      lerp(a.pos[0], b.pos[0], k),
      lerp(a.pos[1], b.pos[1], k),
      lerp(a.pos[2], b.pos[2], k),
    );
    tgtLook.set(
      lerp(a.look[0], b.look[0], k),
      lerp(a.look[1], b.look[1], k),
      lerp(a.look[2], b.look[2], k),
    );
    if (portrait) {
      tgtPos.z += 5.0;
      tgtLook.y += 1.2;
    }
    return {
      fov: lerp(a.fov, b.fov, k) * (portrait ? 1.2 : 1),
      roll: lerp(a.roll, b.roll, k),
    };
  }

  /* --- state: driven by a play clock --- */
  /* heroT eases toward BLOOM_HOLD across `playMs`, so the camera pushes in
     and the branch flowers fully without ever entering the exit range. */
  const BLOOM_HOLD = 0.68;
  let heroT = 0;
  let shown = 0;
  let playStart = 0;
  let playMs = 4200;
  let playing = false;
  const pointer = { x: 0, y: 0, tx: 0, ty: 0 };

  const onPointerMove = (e: PointerEvent) => {
    pointer.tx = (e.clientX / window.innerWidth - 0.5) * 2;
    pointer.ty = (e.clientY / window.innerHeight - 0.5) * 2;
  };
  const onResize = () => resize();
  window.addEventListener("pointermove", onPointerMove, { passive: true });
  window.addEventListener("resize", onResize);

  /* --- scratch --- */
  const m4 = new THREE.Matrix4();
  const m4b = new THREE.Matrix4();
  const m4c = new THREE.Matrix4();
  const qp = new THREE.Quaternion();
  const tp = new THREE.Vector3();
  const sp = new THREE.Vector3();
  const qv = new THREE.Quaternion();
  const ev = new THREE.Euler();
  const sv = new THREE.Vector3();

  function resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    portrait = h > w;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
    if (composer) composer.setSize(w, h);
  }
  resize();

  let t = 0;
  let raf = 0;
  let lastLeafT = -1;

  function frame() {
    raf = requestAnimationFrame(frame);
    t += 0.016;

    if (playing) {
      const k = clamp((performance.now() - playStart) / playMs, 0, 1);
      heroT = smooth(k) * BLOOM_HOLD;
    }
    shown += (heroT - shown) * 0.08;
    // the unfurl finishes a little before the branch leaves the frame
    const bloomT = clamp(shown / 0.72, 0, 1);

    const shot = sampleShot(shown);
    pointer.x += (pointer.tx - pointer.x) * 0.05;
    pointer.y += (pointer.ty - pointer.y) * 0.05;
    camPos.lerp(tgtPos, 0.1);
    camLook.lerp(tgtLook, 0.1);
    camera.position.set(
      camPos.x + pointer.x * 0.42,
      camPos.y - pointer.y * 0.3 + Math.sin(t * 0.3) * 0.06,
      camPos.z,
    );
    camera.lookAt(camLook);
    camera.rotation.z = shot.roll + Math.sin(t * 0.21) * 0.006;
    if (Math.abs(camera.fov - shot.fov) > 0.01) {
      camera.fov = shot.fov;
      camera.updateProjectionMatrix();
    }

    /* past 0.78 the branch clears the frame; play holds short of it at BLOOM_HOLD */
    const exit = smooth(clamp((shown - 0.78) / 0.2, 0, 1));
    group.position.y = exit * 16;
    group.position.x = exit * -4;
    group.rotation.z = Math.sin(t * 0.18) * 0.012 - exit * 0.16;
    group.visible = shown < 0.965;

    glow.position.set(camera.position.x - 2.4, camera.position.y + 2.6, camera.position.z - 5.2);
    glow.intensity = 7 + Math.sin(t * 1.6) * 1.4;

    /* leaves come in just ahead of the flowers */
    const leafT = smooth(clamp(bloomT / 0.26, 0, 1));
    if (Math.abs(leafT - lastLeafT) > 0.001) {
      lastLeafT = leafT;
      for (let i = 0; i < leaves.length; i += 1) {
        const l = leaves[i];
        if (!l) continue;
        const g = smooth(clamp((leafT - l.cue) / 0.4, 0, 1));
        const sc = l.size * g;
        leafMesh.setMatrixAt(i, m4.compose(l.pos, l.quat, sv.set(sc, sc, sc)));
      }
      leafMesh.instanceMatrix.needsUpdate = true;
    }

    if (group.visible) {
      for (let i = 0; i < bloomState.length; i += 1) {
        const b = bloomState[i];
        if (!b) continue;

        /* the bud swells out of the wood, then holds */
        const bud = smooth(clamp((bloomT - b.cue) / 0.1, 0, 1));

        const sway = Math.sin(t * b.speed + b.phase);
        qv.setFromEuler(
          ev.set(sway * 0.05, sway * 0.09, Math.cos(t * b.speed * 0.8 + b.phase) * 0.05),
        );
        qv.premultiply(b.quat);
        const s = b.size * bud * (1 + sway * 0.018);
        m4.compose(b.pos, qv, sv.set(s, s, s));

        const petals = localPetals[i];
        if (!petals) continue;
        let core = 0;

        for (let p = 0; p < petals.length; p += 1) {
          const pt = petals[p];
          if (!pt) continue;

          /* every petal has its own cue — outer ring leads, centre follows */
          const o = smooth(clamp((bloomT - b.cue - pt.cue) / UNFURL, 0, 1));
          core = o; // the last petal written is the innermost whorl

          const pitch = lerp(PITCH_CLOSED, pt.pitchOpen, o);
          // the bud is wound shut; it unwinds as it opens
          const roll = pt.roll + (1 - o) * pt.twist;
          const psc = pt.scale * (0.26 + 0.74 * o);
          const prad = pt.radius * o;

          ev.set(pitch - Math.PI / 2, 0, roll, "ZYX");
          qp.setFromEuler(ev);
          qp.premultiply(pt.qAz);
          tp.set(Math.sin(pt.az) * prad, prad * 0.35, Math.cos(pt.az) * prad);
          m4c.compose(tp, qp, sp.set(psc, psc, psc));

          m4b.multiplyMatrices(m4, m4c);
          petalMesh.setMatrixAt(i * PETALS_PER_BLOOM + p, m4b);
        }

        /* the stamens are only visible once the centre has opened */
        const st = localStamens[i];
        if (!st) continue;
        for (let p = 0; p < STAMENS; p += 1) {
          const stamen = st[p];
          if (!stamen) continue;
          m4c.copy(stamen).scale(sv.set(core, core, core));
          m4b.multiplyMatrices(m4, m4c);
          stamenMesh.setMatrixAt(i * STAMENS + p, m4b);
        }
      }
      petalMesh.instanceMatrix.needsUpdate = true;
      stamenMesh.instanceMatrix.needsUpdate = true;
    }

    if (composer) composer.render();
    else renderer.render(scene, camera);
  }

  if (reduced) {
    heroT = 0.12;
    shown = 0.12;
    sampleShot(0.12);
    camPos.copy(tgtPos);
    camLook.copy(tgtLook);
    frame();
    cancelAnimationFrame(raf);
  } else {
    raf = requestAnimationFrame(frame);
  }

  return {
    /** Start the one-shot bloom; the camera settles once it completes. */
    play(durationMs: number = 4200) {
      if (reduced) return;
      playMs = Math.max(800, durationMs);
      playStart = performance.now();
      playing = true;
    },
    dispose() {
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("resize", onResize);
      renderer.dispose();
      pmrem.dispose();
    },
  };
}

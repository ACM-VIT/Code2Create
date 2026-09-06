import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

/**
 * Chill mode's room: a mirror-tiled ball on a chain, lowered from above the
 * frame into the top of the viewport, turning slowly under coloured lights.
 * The room has depth: pools of colour on the floor where the beams land, a field of glints on the walls, soft motes
 * drifting close to the lens, and a camera that leans with the pointer so
 * near things slide past far ones. Everything is transform-driven and the
 * loop pauses when the tab is hidden.
 */

export type ChillScene = {
  /** Lowers the ball into the room; resolves once it has settled. */
  enter: () => Promise<void>;
  /** Hoists it back out of frame; resolves once it is gone. */
  leave: () => Promise<void>;
  dispose: () => void;
};

const REST_Y = 2.1;
const ENTRY_Y = 7.6;
const CHAIN_TOP = 10.5;
const FLOOR_Y = -1.6;
const BALL_RADIUS = 1;
const BEAM_COLOURS = ["#feb4cb", "#b391ff", "#8fd3ff", "#ffd8a8"] as const;

function easeOutBack(t: number) {
  const c1 = 0.9;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

function easeInCubic(t: number) {
  return t * t * t;
}

/** Mirror tiles laid in latitude rings over a dark core, like the real thing. */
function createBall() {
  const group = new THREE.Group();
  const core = new THREE.Mesh(
    new THREE.SphereGeometry(BALL_RADIUS * 0.985, 32, 24),
    new THREE.MeshStandardMaterial({ color: "#1a0a10", roughness: 0.9, metalness: 0 }),
  );
  group.add(core);

  const tile = new THREE.BoxGeometry(0.105, 0.105, 0.02);
  const mirror = new THREE.MeshStandardMaterial({
    color: "#eceef2",
    metalness: 1,
    roughness: 0.05,
    envMapIntensity: 1.9,
  });
  const rings = 24;
  const matrices: THREE.Matrix4[] = [];
  const outward = new THREE.Vector3(0, 0, 1);
  const unit = new THREE.Vector3(1, 1, 1);
  for (let ring = 0; ring < rings; ring++) {
    const lat = -Math.PI / 2 + ((ring + 0.5) * Math.PI) / rings;
    const radius = Math.cos(lat) * BALL_RADIUS;
    const count = Math.max(1, Math.round((2 * Math.PI * radius) / 0.118));
    for (let index = 0; index < count; index++) {
      const lon = (index / count) * Math.PI * 2 + ((ring % 2) * Math.PI) / count;
      const position = new THREE.Vector3(
        radius * Math.cos(lon),
        Math.sin(lat) * BALL_RADIUS,
        radius * Math.sin(lon),
      );
      const rotation = new THREE.Quaternion().setFromUnitVectors(outward, position.clone().normalize());
      matrices.push(new THREE.Matrix4().compose(position, rotation, unit));
    }
  }
  const tiles = new THREE.InstancedMesh(tile, mirror, matrices.length);
  matrices.forEach((matrix, index) => tiles.setMatrixAt(index, matrix));
  tiles.instanceMatrix.needsUpdate = true;
  group.add(tiles);

  const cap = new THREE.Mesh(
    new THREE.CylinderGeometry(0.09, 0.14, 0.12, 16),
    new THREE.MeshStandardMaterial({ color: "#c9c9d2", metalness: 1, roughness: 0.25 }),
  );
  cap.position.y = BALL_RADIUS + 0.02;
  group.add(cap);

  return {
    group,
    dispose: () => {
      core.geometry.dispose();
      core.material.dispose();
      tile.dispose();
      mirror.dispose();
      cap.geometry.dispose();
      cap.material.dispose();
    },
  };
}

/** A soft white radial disc: the halo behind the ball and the pools on the floor. */
function createSoftDisc() {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (context) {
    const gradient = context.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, "rgba(255, 255, 255, 0.9)");
    gradient.addColorStop(0.35, "rgba(255, 255, 255, 0.35)");
    gradient.addColorStop(1, "rgba(255, 255, 255, 0)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, size, size);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Four soft cones from the ball, each on its own slow pivot. */
function createBeams() {
  const group = new THREE.Group();
  const pivots: { pivot: THREE.Group; beam: THREE.Mesh; speed: number }[] = [];
  const geometry = new THREE.ConeGeometry(0.62, 9, 20, 1, true);
  geometry.translate(0, -4.5, 0);
  const materials = BEAM_COLOURS.map(
    (colour) =>
      new THREE.MeshBasicMaterial({
        color: colour,
        transparent: true,
        opacity: 0.06,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
  );
  materials.forEach((material, index) => {
    const pivot = new THREE.Group();
    const beam = new THREE.Mesh(geometry, material);
    beam.rotation.x = 0.42 + index * 0.13;
    pivot.add(beam);
    pivot.rotation.y = (index / materials.length) * Math.PI * 2;
    group.add(pivot);
    pivots.push({ pivot, beam, speed: (index % 2 === 0 ? 1 : -1) * (0.16 + index * 0.05) });
  });
  return {
    group,
    pivots,
    setOpacity: (value: number) => materials.forEach((material) => (material.opacity = value)),
    dispose: () => {
      geometry.dispose();
      materials.forEach((material) => material.dispose());
    },
  };
}

/**
 * Where a beam meets the floor it leaves a pool of its colour: a soft
 * additive disc lying on the floor plane, placed each frame from the beam's
 * world direction. No lighting is involved, so nothing else on the page
 * changes — the pools are the whole floor.
 */
function createPools(disc: THREE.Texture) {
  const geometry = new THREE.PlaneGeometry(1, 1);
  const pools = BEAM_COLOURS.map((colour) => {
    const material = new THREE.MeshBasicMaterial({
      map: disc,
      color: colour,
      transparent: true,
      opacity: 0.3,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.rotation.x = -Math.PI / 2;
    const anchor = new THREE.Group();
    anchor.add(mesh);
    return { anchor, mesh, material };
  });
  const origin = new THREE.Vector3();
  const direction = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  const down = new THREE.Vector3(0, -1, 0);
  return {
    anchors: pools.map((pool) => pool.anchor),
    /** Aim every pool at its beam's footprint on the floor. */
    follow: (beams: readonly { beam: THREE.Mesh }[], ballCentre: THREE.Vector3) => {
      beams.forEach(({ beam }, index) => {
        const pool = pools[index];
        if (!pool) return;
        beam.getWorldQuaternion(rotation);
        direction.copy(down).applyQuaternion(rotation);
        if (direction.y > -0.05) {
          pool.anchor.visible = false;
          return;
        }
        const distance = (FLOOR_Y - ballCentre.y) / direction.y;
        origin.copy(ballCentre).addScaledVector(direction, distance);
        pool.anchor.visible = true;
        pool.anchor.position.set(origin.x, FLOOR_Y + 0.01, origin.z);
        pool.anchor.rotation.y = Math.atan2(direction.x, direction.z);
        const stretch = Math.min(3.2, 1 / -direction.y);
        pool.mesh.scale.set(1.9, 1.9 * stretch, 1);
        pool.material.opacity = 0.34 * Math.min(1, 7 / distance);
      });
    },
    dispose: () => {
      geometry.dispose();
      pools.forEach((pool) => pool.material.dispose());
    },
  };
}

const twinkleVertex = `
  attribute float phase;
  attribute float size;
  uniform float time;
  varying float vAlpha;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float twinkle = 0.5 + 0.5 * sin(time * 2.4 + phase * 6.2831);
    vAlpha = smoothstep(0.5, 1.0, twinkle);
    gl_PointSize = size * (280.0 / -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;

const twinkleFragment = `
  uniform vec3 color;
  uniform float strength;
  varying float vAlpha;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.05, d) * vAlpha * strength;
    gl_FragColor = vec4(color, a);
  }
`;

type Cloud = { box: [number, number, number, number, number, number]; size: [number, number]; strength: number };

/** Points that twinkle out of phase: small and sharp on the walls, large and soft near the lens. */
function createPoints(count: number, colour: string, cloud: Cloud) {
  const positions = new Float32Array(count * 3);
  const phases = new Float32Array(count);
  const sizes = new Float32Array(count);
  const [x0, x1, y0, y1, z0, z1] = cloud.box;
  for (let index = 0; index < count; index++) {
    positions[index * 3] = x0 + Math.random() * (x1 - x0);
    positions[index * 3 + 1] = y0 + Math.random() * (y1 - y0);
    positions[index * 3 + 2] = z0 + Math.random() * (z1 - z0);
    phases[index] = Math.random();
    sizes[index] = cloud.size[0] + Math.random() * (cloud.size[1] - cloud.size[0]);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("phase", new THREE.BufferAttribute(phases, 1));
  geometry.setAttribute("size", new THREE.BufferAttribute(sizes, 1));
  const time = { value: 0 };
  const material = new THREE.ShaderMaterial({
    uniforms: { time, color: { value: new THREE.Color(colour) }, strength: { value: cloud.strength } },
    vertexShader: twinkleVertex,
    fragmentShader: twinkleFragment,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const points = new THREE.Points(geometry, material);
  return {
    points,
    time,
    dispose: () => {
      geometry.dispose();
      material.dispose();
    },
  };
}

export function createChillScene(
  canvas: HTMLCanvasElement,
  { reducedMotion }: { reducedMotion: boolean },
): ChillScene {
  const context = canvas.getContext("webgl2", { alpha: true, antialias: true });
  if (!context) throw new Error("WebGL is unavailable.");
  const renderer = new THREE.WebGLRenderer({ canvas, context, alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.setClearColor(0, 0);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const scene = new THREE.Scene();
  const room = new RoomEnvironment();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const environment = pmrem.fromScene(room, 0.04);
  scene.environment = environment.texture;
  scene.environmentIntensity = 0.9;
  room.dispose();
  pmrem.dispose();

  scene.add(new THREE.HemisphereLight("#f6e4ec", "#1a0a10", 0.45));
  const lampA = new THREE.PointLight("#feb4cb", 9, 14, 1.6);
  const lampB = new THREE.PointLight("#8fd3ff", 7, 14, 1.6);
  scene.add(lampA, lampB);


  const ball = createBall();
  const rig = new THREE.Group();
  rig.position.y = ENTRY_Y;
  rig.add(ball.group);
  scene.add(rig);

  const softDisc = createSoftDisc();
  const halo = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: softDisc,
      color: "#feb4cb",
      transparent: true,
      opacity: 0.32,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  halo.scale.set(6.5, 6.5, 1);
  halo.position.z = -0.6;
  rig.add(halo);

  const beams = createBeams();
  rig.add(beams.group);
  if (reducedMotion) beams.setOpacity(0.045);
  const pools = createPools(softDisc);
  scene.add(...pools.anchors);
  const ballCentre = new THREE.Vector3();

  const chain = new THREE.Mesh(
    new THREE.CylinderGeometry(0.018, 0.018, 1, 8),
    new THREE.MeshStandardMaterial({ color: "#b9b9c4", metalness: 1, roughness: 0.35 }),
  );
  scene.add(chain);

  // Three depths of sparkle: the walls far back, the room around the ball,
  // and soft motes just in front of the lens.
  const wallGlints = createPoints(420, "#ffe6ee", {
    box: [-14, 14, -2, 9, -12, -3],
    size: [0.05, 0.1],
    strength: 1,
  });
  const roomGlints = createPoints(200, "#b391ff", {
    box: [-8, 8, -1.5, 6, -3, 3],
    size: [0.06, 0.12],
    strength: 0.9,
  });
  const motes = createPoints(70, "#ffd8e6", {
    box: [-6, 6, -3, 4, 4, 7.4],
    size: [0.28, 0.7],
    strength: 0.16,
  });
  scene.add(wallGlints.points, roomGlints.points, motes.points);

  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 80);
  const cameraHome = new THREE.Vector3(0, 0.6, 8.6);
  const lookAt = new THREE.Vector3(0, 1.4, 0);
  camera.position.copy(cameraHome);
  camera.lookAt(lookAt);

  // The camera leans with the pointer and drifts on its own, so glints near
  // the lens slide past the ones on the walls.
  const pointer = new THREE.Vector2(0, 0);
  const onPointerMove = (event: PointerEvent) => {
    pointer.set(
      (event.clientX / window.innerWidth) * 2 - 1,
      -((event.clientY / window.innerHeight) * 2 - 1),
    );
  };
  if (!reducedMotion) window.addEventListener("pointermove", onPointerMove, { passive: true });

  const resize = () => {
    const width = canvas.clientWidth || window.innerWidth;
    const height = canvas.clientHeight || window.innerHeight;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };
  resize();
  window.addEventListener("resize", resize);

  // ---- motion -------------------------------------------------------------
  type Move = {
    from: number;
    to: number;
    startedAt: number;
    duration: number;
    ease: (t: number) => number;
    resolve: () => void;
  };
  let move: Move | null = null;
  let elapsed = 0;
  let frame = 0;
  let disposed = false;
  let last = performance.now();
  const spin = reducedMotion ? 0.02 : 0.32;
  const cameraTarget = new THREE.Vector3();

  const moveTo = (to: number, duration: number, ease: (t: number) => number) =>
    new Promise<void>((resolve) => {
      move?.resolve();
      if (reducedMotion || duration === 0) {
        rig.position.y = to;
        move = null;
        resolve();
        return;
      }
      move = { from: rig.position.y, to, startedAt: performance.now(), duration, ease, resolve };
    });

  const tick = () => {
    frame = requestAnimationFrame(tick);
    const now = performance.now();
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    elapsed += dt;
    if (move) {
      const k = Math.min(1, (now - move.startedAt) / move.duration);
      rig.position.y = move.from + (move.to - move.from) * move.ease(k);
      if (k >= 1) {
        move.resolve();
        move = null;
      }
    }
    ball.group.rotation.y += spin * dt;
    if (!reducedMotion) {
      rig.rotation.z = Math.sin(elapsed * 0.6) * 0.035;
      for (const { pivot, speed } of beams.pivots) pivot.rotation.y += speed * dt;
      wallGlints.time.value = elapsed;
      roomGlints.time.value = elapsed * 0.8 + 3;
      motes.time.value = elapsed * 0.35 + 7;
      wallGlints.points.rotation.y = elapsed * 0.012;
      roomGlints.points.rotation.y = -elapsed * 0.02;
      motes.points.position.y = Math.sin(elapsed * 0.18) * 0.4;
      motes.points.position.x = Math.cos(elapsed * 0.13) * 0.3;
      lampA.position.set(Math.cos(elapsed * 0.5) * 4, 3.2 + Math.sin(elapsed * 0.3), Math.sin(elapsed * 0.5) * 4);
      lampB.position.set(Math.cos(elapsed * 0.35 + 2) * 4, 1.2 + Math.cos(elapsed * 0.4), Math.sin(elapsed * 0.35 + 2) * 4);
      cameraTarget.set(
        cameraHome.x + pointer.x * 0.7 + Math.sin(elapsed * 0.16) * 0.25,
        cameraHome.y + pointer.y * 0.4 + Math.cos(elapsed * 0.11) * 0.15,
        cameraHome.z,
      );
      camera.position.lerp(cameraTarget, 1 - Math.exp(-dt * 2.2));
      camera.lookAt(lookAt);
    } else {
      lampA.position.set(3, 3.5, 3);
      lampB.position.set(-3, 1.5, 3);
    }
    rig.updateMatrixWorld(true);
    ball.group.getWorldPosition(ballCentre);
    pools.follow(beams.pivots, ballCentre);
    const chainBottom = rig.position.y + BALL_RADIUS + 0.08;
    const length = Math.max(0.01, CHAIN_TOP - chainBottom);
    chain.scale.y = length;
    chain.position.y = chainBottom + length / 2;
    renderer.render(scene, camera);
  };

  const start = () => {
    if (disposed || frame !== 0) return;
    last = performance.now();
    frame = requestAnimationFrame(tick);
  };
  const stop = () => {
    if (frame !== 0) cancelAnimationFrame(frame);
    frame = 0;
  };
  const onVisibility = () => (document.hidden ? stop() : start());
  document.addEventListener("visibilitychange", onVisibility);
  if (!document.hidden) start();

  return {
    enter: () => moveTo(REST_Y, 2600, easeOutBack),
    leave: () => moveTo(ENTRY_Y, 1500, easeInCubic),
    dispose: () => {
      disposed = true;
      stop();
      move?.resolve();
      move = null;
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("visibilitychange", onVisibility);
      ball.dispose();
      beams.dispose();
      wallGlints.dispose();
      roomGlints.dispose();
      motes.dispose();
      halo.material.dispose();
      softDisc.dispose();
      pools.dispose();
      chain.geometry.dispose();
      chain.material.dispose();
      environment.dispose();
      renderer.dispose();
    },
  };
}

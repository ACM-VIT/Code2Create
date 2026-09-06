import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

import { createTurntableModel, RECORD_CENTER } from "./turntableModel";
import { advanceTurntable, createTurntableMotion, recordDragDelta, RECORD_SPEED } from "./turntableMotion";
import { createDeckBranding, createGrooveTexture, createRecordLabel } from "./turntableTextures";

export type TurntablePlayback = {
  title: string;
  artist: string;
  playing: boolean;
  startedAt: number | undefined;
  durationSeconds: number;
};

export type TurntableScene = {
  setPlayback: (playback: TurntablePlayback) => void;
  zoom: (direction: "in" | "out") => void;
  resetView: () => void;
  spinRecord: () => void;
  dispose: () => void;
};

export function createTurntableScene(canvas: HTMLCanvasElement, onUnavailable: () => void): TurntableScene {
  const context = canvas.getContext("webgl2", { alpha: true, antialias: true });
  if (!context) throw new Error("WebGL is unavailable.");
  const renderer = new THREE.WebGLRenderer({ canvas, context, alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
  renderer.setClearColor(0, 0);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.95;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  const scene = new THREE.Scene();
  const room = new RoomEnvironment();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const environment = pmrem.fromScene(room, 0.04);
  scene.environment = environment.texture;
  scene.environmentIntensity = 0.85;
  room.dispose();
  pmrem.dispose();

  const key = new THREE.DirectionalLight("#fff0e8", 2.8);
  key.position.set(-3, 7, 4);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  Object.assign(key.shadow.camera, { left: -4, right: 4, top: 4, bottom: -4, near: 0.1, far: 20 });
  key.shadow.bias = -0.0005;
  key.shadow.normalBias = 0.025;
  key.shadow.radius = 4;
  scene.add(key);
  const rim = new THREE.DirectionalLight("#feb4cb", 2);
  rim.position.set(4, 3, -5);
  scene.add(rim, new THREE.HemisphereLight("#fce5eb", "#332734", 1));

  const label = createRecordLabel();
  const grooveTexture = createGrooveTexture();
  grooveTexture.anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), 8);
  label.texture.anisotropy = grooveTexture.anisotropy;
  const branding = createDeckBranding(wake);
  const model = createTurntableModel(label.texture, grooveTexture, branding);
  scene.add(model.root);

  const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 60);
  camera.position.set(3.5, 4.1, 6.8);
  const controls = new OrbitControls(camera, canvas);
  controls.target.set(0, 0.65, 0);
  controls.enablePan = false;
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.rotateSpeed = 0.65;
  controls.zoomSpeed = 0.6;
  controls.minDistance = 5.5;
  controls.maxDistance = 13;
  controls.minPolarAngle = 0.18;
  controls.maxPolarAngle = Math.PI / 2 - 0.1;
  controls.update();
  controls.saveState();

  const motion = createTurntableMotion();
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let playback: TurntablePlayback = { title: "Between tracks", artist: "Code2Create", playing: false, startedAt: undefined, durationSeconds: 0 };
  let frame = 0;
  let lastFrame = 0;
  let visible = true;
  let disposed = false;
  let drag: { pointerId: number; angle: number; at: number } | null = null;
  let cameraDragging = false;
  const parallax = new THREE.Vector2();
  let charmAngle = 0.16;
  let charmSpeed = 0;
  let lastAzimuth = controls.getAzimuthalAngle();
  let entrance = 0;

  function wake() {
    if (!disposed && visible && !document.hidden && !frame) frame = requestAnimationFrame(render);
  }

  function render(now: number) {
    frame = 0;
    const delta = lastFrame ? (now - lastFrame) / 1000 : 1 / 60;
    const step = Math.min(delta, 0.05);
    lastFrame = now;
    const progress = playback.startedAt === undefined || playback.durationSeconds <= 0
      ? 0 : (Date.now() - playback.startedAt) / (playback.durationSeconds * 1000);
    const moving = advanceTurntable(motion, {
      playing: playback.playing, dragging: drag !== null, reducedMotion: reducedMotion.matches, progress,
    }, delta);
    model.record.rotation.y = motion.rotation;
    if (playback.playing && !reducedMotion.matches) {
      model.platter.rotation.y = (model.platter.rotation.y + RECORD_SPEED * Math.min(delta, 0.05)) % (Math.PI * 2);
    }
    model.arm.rotation.y = motion.armAngle;
    model.arm.position.y = 1.1 + motion.armLift;

    entrance = reducedMotion.matches ? 1 : Math.min(1, entrance + step / 1.25);
    const approach = 1 - Math.pow(1 - entrance, 3);
    const idle = playback.playing && !reducedMotion.matches && drag === null;
    const hover = idle ? Math.sin(now * 0.0011) * 0.025 : 0;
    let depthMoving = false;
    if (drag === null) {
      const targetX = reducedMotion.matches ? 0.065 : 0.065 + parallax.y * 0.055;
      const targetY = reducedMotion.matches ? -0.1 : -0.1 + parallax.x * 0.085;
      const targetZ = reducedMotion.matches ? -0.055 : -0.055 - parallax.x * 0.035;
      const blend = reducedMotion.matches ? 1 : 1 - Math.exp(-5 * step);
      model.root.rotation.x += (targetX - model.root.rotation.x) * blend;
      model.root.rotation.y += (targetY - model.root.rotation.y) * blend;
      model.root.rotation.z += (targetZ - model.root.rotation.z) * blend;
      depthMoving = Math.abs(targetX - model.root.rotation.x) + Math.abs(targetY - model.root.rotation.y) + Math.abs(targetZ - model.root.rotation.z) > 0.0001;
      model.root.position.y = 1.05 + hover;
    }
    model.root.position.z = -2.8 * (1 - approach);
    model.root.scale.setScalar(0.86 + approach * 0.14);
    if (reducedMotion.matches) {
      charmSpeed = 0;
      charmAngle = 0;
    } else {
      charmSpeed += (-charmAngle * 17 - charmSpeed * 2.5) * step;
      charmAngle += charmSpeed * step;
    }
    model.charm.rotation.z = charmAngle;
    model.charm.rotation.x = 0.14 + charmAngle * 0.3;
    const cameraMoved = controls.update();
    renderer.render(scene, camera);
    if (moving || cameraMoved || depthMoving || entrance < 1 || Math.abs(charmAngle) + Math.abs(charmSpeed) > 0.001 || idle) wake();
  }

  function resize() {
    const { width, height } = canvas.getBoundingClientRect();
    if (width === 0 || height === 0) return;
    camera.aspect = width / height;
    const desktop = width >= 1024;
    const laptop = desktop && height <= 900;
    canvas.style.touchAction = desktop ? "none" : "pan-y";
    const horizontalHalfAngle = desktop ? 33 : 26;
    camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(horizontalHalfAngle)) / camera.aspect));
    // Compose the deck across the room, leaving the desk's queue to its right.
    const verticalOffset = desktop ? (laptop ? -height * 0.045 : 0) : height * 0.025;
    camera.setViewOffset(width, height, desktop ? width * 0.16 : 0, verticalOffset, width, height);
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
    wake();
  }

  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(canvas);
  const intersectionObserver = new IntersectionObserver(([entry]) => {
    visible = entry?.isIntersecting ?? false;
    updateVisibility();
  });
  intersectionObserver.observe(canvas);

  function updateVisibility() {
    if (!visible || document.hidden) {
      cancelAnimationFrame(frame);
      frame = 0;
      lastFrame = 0;
      endRecordDrag();
    } else wake();
  }

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const point = new THREE.Vector3();
  const planeNormal = new THREE.Vector3();
  const planeCenter = new THREE.Vector3();
  const recordPlane = new THREE.Plane();

  function pointAt(event: PointerEvent) {
    const rect = canvas.getBoundingClientRect();
    pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, 1 - ((event.clientY - rect.top) / rect.height) * 2);
    raycaster.setFromCamera(pointer, camera);
  }

  function recordAngle() {
    model.root.updateMatrixWorld(true);
    planeNormal.set(0, 1, 0).transformDirection(model.root.matrixWorld);
    planeCenter.copy(RECORD_CENTER).applyMatrix4(model.root.matrixWorld);
    recordPlane.setFromNormalAndCoplanarPoint(planeNormal, planeCenter);
    if (!raycaster.ray.intersectPlane(recordPlane, point)) return null;
    model.root.worldToLocal(point);
    return Math.atan2(point.z - RECORD_CENTER.z, point.x - RECORD_CENTER.x);
  }

  function onPointerDown(event: PointerEvent) {
    if (drag || cameraDragging || !event.isPrimary || event.button !== 0) return;
    pointAt(event);
    if (raycaster.intersectObject(model.surface, false).length === 0) return;
    const angle = recordAngle();
    if (angle === null) return;
    controls.enabled = false;
    motion.speed = 0;
    drag = { pointerId: event.pointerId, angle, at: event.timeStamp };
    canvas.setPointerCapture(event.pointerId);
    canvas.style.cursor = "grabbing";
    canvas.focus({ preventScroll: true });
    wake();
  }

  function onPointerMove(event: PointerEvent) {
    pointAt(event);
    if (event.pointerType === "mouse" && !cameraDragging && !drag) {
      parallax.set(pointer.x, pointer.y);
      wake();
    }
    if (!drag) {
      if (!cameraDragging) canvas.style.cursor = raycaster.intersectObject(model.surface, false).length ? "ew-resize" : "grab";
      return;
    }
    if (event.pointerId !== drag.pointerId) return;
    const angle = recordAngle();
    if (angle === null) return;
    const rotation = recordDragDelta(drag.angle, angle);
    motion.rotation += rotation;
    charmSpeed += rotation * 0.65;
    motion.speed = THREE.MathUtils.clamp(rotation / Math.max((event.timeStamp - drag.at) / 1000, 0.008), -14, 14);
    drag.angle = angle;
    drag.at = event.timeStamp;
    wake();
  }

  function endRecordDrag() {
    if (!drag) return;
    const pointerId = drag.pointerId;
    if (performance.now() - drag.at > 100) motion.speed = 0;
    drag = null;
    if (canvas.hasPointerCapture(pointerId)) canvas.releasePointerCapture(pointerId);
    controls.enabled = true;
    canvas.style.cursor = "grab";
    wake();
  }

  function onPointerEnd(event: PointerEvent) {
    if (event.pointerId === drag?.pointerId) {
      // OrbitControls never received this pointerdown; don't give it the release.
      event.stopImmediatePropagation();
      endRecordDrag();
    }
  }

  function resetView() {
    endRecordDrag();
    controls.enableDamping = false;
    controls.reset();
    controls.update();
    controls.enableDamping = !reducedMotion.matches;
    wake();
  }

  function zoom(direction: "in" | "out") {
    if (direction === "in") controls.dollyIn(0.85);
    else controls.dollyOut(0.85);
    wake();
  }

  function spinRecord() {
    if (reducedMotion.matches) motion.rotation -= Math.PI / 2;
    else { motion.speed = -12; charmSpeed += 0.8; }
    wake();
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    switch (event.key) {
      case "ArrowLeft": controls.rotateLeft(0.15); break;
      case "ArrowRight": controls.rotateLeft(-0.15); break;
      case "ArrowUp": controls.rotateUp(0.12); break;
      case "ArrowDown": controls.rotateUp(-0.12); break;
      case "+": case "=": zoom("in"); break;
      case "-": zoom("out"); break;
      case "Home": resetView(); break;
      case " ": spinRecord(); break;
      default: return;
    }
    event.preventDefault();
    event.stopPropagation();
    wake();
  }

  function onMotionPreference() {
    controls.enableDamping = !reducedMotion.matches;
    wake();
  }
  function onOrbitStart() { cameraDragging = true; canvas.style.cursor = "grabbing"; }
  function onOrbitEnd() { cameraDragging = false; canvas.style.cursor = "grab"; }
  function onViewChange() {
    const azimuth = controls.getAzimuthalAngle();
    if (!reducedMotion.matches) charmSpeed += THREE.MathUtils.clamp(recordDragDelta(lastAzimuth, azimuth), -0.12, 0.12) * 3;
    lastAzimuth = azimuth;
    wake();
  }
  function onPointerLeave() { parallax.set(0, 0); wake(); }

  controls.addEventListener("change", onViewChange);
  controls.addEventListener("start", onOrbitStart);
  controls.addEventListener("end", onOrbitEnd);
  canvas.addEventListener("pointerdown", onPointerDown, true);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerleave", onPointerLeave);
  canvas.addEventListener("pointerup", onPointerEnd, true);
  canvas.addEventListener("pointercancel", onPointerEnd, true);
  canvas.addEventListener("lostpointercapture", endRecordDrag);
  canvas.addEventListener("keydown", onKeyDown);
  canvas.addEventListener("webglcontextlost", onUnavailable);
  document.addEventListener("visibilitychange", updateVisibility);
  reducedMotion.addEventListener("change", onMotionPreference);
  label.update(playback.title, playback.artist);
  onMotionPreference();
  resize();

  return {
    setPlayback(next) {
      if (next.title !== playback.title || next.artist !== playback.artist) label.update(next.title, next.artist);
      playback = next;
      model.indicator.emissiveIntensity = next.playing ? 2.5 : 0;
      wake();
    },
    zoom, resetView, spinRecord,
    dispose() {
      disposed = true;
      cancelAnimationFrame(frame);
      endRecordDrag();
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      document.removeEventListener("visibilitychange", updateVisibility);
      reducedMotion.removeEventListener("change", onMotionPreference);
      canvas.removeEventListener("pointerdown", onPointerDown, true);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerleave", onPointerLeave);
      canvas.removeEventListener("pointerup", onPointerEnd, true);
      canvas.removeEventListener("pointercancel", onPointerEnd, true);
      canvas.removeEventListener("lostpointercapture", endRecordDrag);
      canvas.removeEventListener("keydown", onKeyDown);
      canvas.removeEventListener("webglcontextlost", onUnavailable);
      controls.dispose();
      model.dispose();
      label.texture.dispose();
      grooveTexture.dispose();
      branding.dispose();
      environment.dispose();
      key.shadow.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}

import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

export const RECORD_CENTER = new THREE.Vector3(-0.64, 0.89, 0);
export const RECORD_RADIUS = 1.72;

/** An assembled model: the deck, platter, vinyl, and cueing arm move independently. */
export function createTurntableModel(
  labelTexture: THREE.Texture,
  grooveTexture: THREE.Texture,
  branding: { front: THREE.Texture; badge: THREE.Texture },
) {
  const root = new THREE.Group();
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();

  const lacquer = new THREE.MeshPhysicalMaterial({
    color: "#39222f", roughness: 0.32, metalness: 0.12, clearcoat: 0.8,
    clearcoatRoughness: 0.24,
  });
  const metal = new THREE.MeshStandardMaterial({ color: "#e5cfcb", roughness: 0.25, metalness: 0.92 });
  const darkMetal = new THREE.MeshStandardMaterial({ color: "#51434a", roughness: 0.36, metalness: 0.85 });
  const rubber = new THREE.MeshStandardMaterial({ color: "#100f13", roughness: 0.8 });
  const vinyl = new THREE.MeshPhysicalMaterial({
    color: "#060509", roughness: 0.42, metalness: 0.08, clearcoat: 0.18,
    clearcoatRoughness: 0.36, envMapIntensity: 0.45, bumpMap: grooveTexture, bumpScale: 0.0015,
  });
  const labelMaterial = new THREE.MeshStandardMaterial({ map: labelTexture, roughness: 0.85 });
  const indicator = new THREE.MeshStandardMaterial({
    color: "#feb4cb", emissive: "#feb4cb", emissiveIntensity: 0,
  });

  function mesh(
    parent: THREE.Group,
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    x: number, y: number, z: number,
  ) {
    geometries.add(geometry);
    materials.add(material);
    const part = new THREE.Mesh(geometry, material);
    part.position.set(x, y, z);
    part.castShadow = true;
    part.receiveShadow = true;
    parent.add(part);
    return part;
  }

  function box(
    parent: THREE.Group, width: number, height: number, depth: number,
    material: THREE.Material, x: number, y: number, z: number, radius = 0.04,
  ) {
    return mesh(parent, new RoundedBoxGeometry(width, height, depth, 3, radius), material, x, y, z);
  }

  function cylinder(
    parent: THREE.Group, radius: number, height: number, material: THREE.Material,
    x: number, y: number, z: number,
  ) {
    return mesh(parent, new THREE.CylinderGeometry(radius, radius, height, 96), material, x, y, z);
  }

  // A lacquer plinth on four isolated rubber feet, with an inset metal top.
  for (const x of [-2.23, 2.23]) {
    for (const z of [-1.53, 1.53]) {
      cylinder(root, 0.24, 0.18, rubber, x, 0.12, z);
      cylinder(root, 0.245, 0.055, darkMetal, x, 0.2, z);
    }
  }
  box(root, 5.76, 0.42, 4.24, lacquer, 0, 0.4, 0, 0.12);
  box(root, 5.65, 0.055, 4.13, darkMetal, 0, 0.618, 0, 0.06);
  box(root, 5.52, 0.024, 4, lacquer, 0, 0.657, 0, 0.05);
  const frontBrand = new THREE.MeshStandardMaterial({ map: branding.front, transparent: true, roughness: 0.55, depthWrite: false });
  mesh(root, new THREE.PlaneGeometry(4.65, 0.31), frontBrand, 0, 0.4, 2.125).castShadow = false;
  const badgeBrand = new THREE.MeshStandardMaterial({ map: branding.badge, transparent: true, roughness: 0.65, depthWrite: false });
  const badge = mesh(root, new THREE.PlaneGeometry(0.78, 0.78), badgeBrand, 1.88, 0.678, 0.78);
  badge.rotation.x = -Math.PI / 2;
  badge.castShadow = false;

  // The platter rotates with the motor, even when a hand holds the record.
  const platter = new THREE.Group();
  platter.position.set(RECORD_CENTER.x, 0, 0);
  root.add(platter);
  cylinder(platter, 1.82, 0.16, metal, 0, 0.75, 0);
  cylinder(platter, 1.77, 0.035, rubber, 0, 0.847, 0);

  const strobeGeometry = new THREE.BoxGeometry(0.041, 0.023, 0.018);
  geometries.add(strobeGeometry);
  const strobes = new THREE.InstancedMesh(strobeGeometry, darkMetal, 240);
  const marker = new THREE.Object3D();
  for (let i = 0; i < 240; i += 1) {
    const angle = ((i % 120) / 120) * Math.PI * 2 + (i >= 120 ? 0.025 : 0);
    marker.position.set(Math.sin(angle) * 1.823, i < 120 ? 0.715 : 0.776, Math.cos(angle) * 1.823);
    marker.rotation.y = angle;
    marker.updateMatrix();
    strobes.setMatrixAt(i, marker.matrix);
  }
  platter.add(strobes);

  const record = new THREE.Group();
  record.position.copy(RECORD_CENTER);
  root.add(record);
  cylinder(record, RECORD_RADIUS, 0.032, rubber, 0, -0.016, 0);
  const surface = mesh(record, new THREE.RingGeometry(0.045, RECORD_RADIUS, 192), vinyl, 0, 0.003, 0);
  surface.rotation.x = -Math.PI / 2;
  const label = mesh(record, new THREE.RingGeometry(0.045, 0.58, 96), labelMaterial, 0, 0.008, 0);
  label.rotation.x = -Math.PI / 2;
  label.castShadow = false;

  // Fine rings give the grooves a real profile at oblique viewing angles.
  const rings: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 54; i += 1) {
    const ring = new THREE.TorusGeometry(0.68 + i * 0.019, 0.002, 3, 160);
    ring.rotateX(-Math.PI / 2);
    rings.push(ring);
  }
  const grooves = mergeGeometries(rings);
  for (const ring of rings) ring.dispose();
  mesh(record, grooves, new THREE.MeshStandardMaterial({
    color: "#18151c", roughness: 0.65, metalness: 0.08,
  }), 0, 0.006, 0).castShadow = false;
  cylinder(root, 0.046, 0.16, metal, RECORD_CENTER.x, 0.94, 0);

  // Gimbal, counterweight, bent aluminium tube, headshell, and stylus.
  cylinder(root, 0.29, 0.07, metal, 1.94, 0.714, -1.18);
  cylinder(root, 0.20, 0.27, darkMetal, 1.94, 0.865, -1.18);
  cylinder(root, 0.13, 0.12, metal, 1.94, 1.04, -1.18);
  const arm = new THREE.Group();
  arm.position.set(1.94, 1.1, -1.18);
  root.add(arm);
  const bearing = cylinder(arm, 0.14, 0.32, metal, 0, 0, 0);
  bearing.rotation.z = Math.PI / 2;
  const armPath = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0, -0.38),
    new THREE.Vector3(0, 0, 0.3),
    new THREE.Vector3(-0.06, -0.04, 0.95),
    new THREE.Vector3(-0.28, -0.1, 1.6),
    new THREE.Vector3(-0.5, -0.12, 2),
  ]);
  mesh(arm, new THREE.TubeGeometry(armPath, 40, 0.04, 10, false), metal, 0, 0, 0);
  const weight = cylinder(arm, 0.16, 0.27, darkMetal, 0, 0, -0.37);
  weight.rotation.x = Math.PI / 2;
  const weightEnd = cylinder(arm, 0.165, 0.025, metal, 0, 0, -0.51);
  weightEnd.rotation.x = Math.PI / 2;
  const headshell = box(arm, 0.2, 0.075, 0.35, darkMetal, -0.51, -0.12, 2.03, 0.024);
  headshell.rotation.y = -0.45;
  const cartridge = box(arm, 0.13, 0.07, 0.15, lacquer, -0.53, -0.185, 2.08, 0.012);
  cartridge.rotation.y = -0.45;
  cylinder(arm, 0.011, 0.048, metal, -0.53, -0.231, 2.08);
  box(arm, 0.025, 0.025, 0.26, metal, -0.35, -0.055, 1.94, 0.008);
  cylinder(root, 0.046, 0.24, metal, 2.35, 0.8, 0.43);
  box(root, 0.23, 0.045, 0.10, rubber, 2.35, 0.94, 0.43, 0.012);

  // The power lamp and physical fittings are part of the model, not audio controls.
  cylinder(root, 0.16, 0.04, metal, -2.39, 0.695, 1.68);
  cylinder(root, 0.125, 0.055, rubber, -2.39, 0.735, 1.68);
  cylinder(root, 0.035, 0.01, indicator, -2.39, 0.769, 1.68);
  box(root, 0.10, 0.012, 0.88, rubber, 2.48, 0.677, 1.21, 0.015);
  box(root, 0.20, 0.06, 0.12, metal, 2.48, 0.712, 1.14, 0.02);

  for (const x of [-2.59, 2.59]) {
    for (const z of [-1.86, 1.86]) {
      cylinder(root, 0.041, 0.009, metal, x, 0.677, z);
      box(root, 0.048, 0.004, 0.007, darkMetal, x, 0.684, z, 0.001);
    }
  }

  // A sakura keychain hangs beyond the front edge, free of the spinning vinyl.
  const roseGold = new THREE.MeshStandardMaterial({ color: "#dbac99", metalness: 0.88, roughness: 0.22 });
  const enamel = new THREE.MeshPhysicalMaterial({
    color: "#f39fbf", metalness: 0.18, roughness: 0.24, clearcoat: 1, clearcoatRoughness: 0.12,
  });
  const hook = mesh(root, new THREE.TorusGeometry(0.075, 0.017, 8, 32), roseGold, 2.71, 0.64, 2.09);
  hook.rotation.y = Math.PI / 5;
  const charm = new THREE.Group();
  charm.position.set(2.71, 0.63, 2.16);
  root.add(charm);
  for (let i = 0; i < 7; i += 1) {
    const link = mesh(charm, new THREE.TorusGeometry(0.033, 0.008, 6, 16), roseGold, 0, -i * 0.052, 0);
    link.rotation.y = i % 2 === 0 ? 0 : Math.PI / 2;
  }
  const petal = new THREE.Shape();
  petal.moveTo(0, 0);
  petal.bezierCurveTo(-0.12, 0.08, -0.15, 0.23, -0.065, 0.29);
  petal.lineTo(0, 0.247);
  petal.lineTo(0.065, 0.29);
  petal.bezierCurveTo(0.15, 0.23, 0.12, 0.08, 0, 0);
  const petalGeometry = new THREE.ExtrudeGeometry(petal, {
    depth: 0.033, bevelEnabled: true, bevelSegments: 2, steps: 1, bevelSize: 0.012, bevelThickness: 0.012, curveSegments: 16,
  });
  for (let i = 0; i < 5; i += 1) {
    const blossom = mesh(charm, petalGeometry, enamel, 0, -0.55, 0);
    blossom.rotation.z = (i / 5) * Math.PI * 2;
  }
  const center = mesh(charm, new THREE.SphereGeometry(0.05, 16, 8), roseGold, 0, -0.55, 0.048);
  center.scale.z = 0.4;
  for (let i = 0; i < 5; i += 1) {
    const angle = (i / 5) * Math.PI * 2;
    mesh(charm, new THREE.SphereGeometry(0.017, 8, 6), roseGold,
      Math.sin(angle) * 0.09, -0.55 + Math.cos(angle) * 0.09, 0.052);
  }

  return {
    root, record, platter, arm, surface, indicator, charm,
    dispose() {
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
      strobes.dispose();
    },
  };
}

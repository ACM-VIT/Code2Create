struct Params {
  resolution: vec2f,
  chestHalfSize: vec2f,
  time: f32,
  intensity: f32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var chestTexture: texture_2d<f32>;
@group(0) @binding(2) var chestSampler: sampler;

const PI: f32 = 3.14159265359;
const TAU: f32 = 6.28318530718;

fn saturate(value: f32) -> f32 {
  return clamp(value, 0.0, 1.0);
}

fn hash11(value: f32) -> f32 {
  return fract(sin(value * 127.1) * 43758.5453);
}

fn rot2(angle: f32) -> mat2x2f {
  let c = cos(angle);
  let s = sin(angle);
  return mat2x2f(c, -s, s, c);
}

fn rotateY(point: vec3f, angle: f32) -> vec3f {
  let rotated = rot2(angle) * point.xz;
  return vec3f(rotated.x, point.y, rotated.y);
}

fn sdBox(point: vec3f, bounds: vec3f) -> f32 {
  let q = abs(point) - bounds;
  return length(max(q, vec3f(0.0))) + min(max(q.x, max(q.y, q.z)), 0.0);
}

fn sdRoundBox(point: vec3f, bounds: vec3f, radius: f32) -> f32 {
  let q = abs(point) - bounds + radius;
  return length(max(q, vec3f(0.0))) + min(max(q.x, max(q.y, q.z)), 0.0) - radius;
}

fn sdOctahedron(point: vec3f, size: f32) -> f32 {
  return (abs(point.x) + abs(point.y) + abs(point.z) - size) * 0.57735027;
}

fn sdOctagon2(pointValue: vec2f, radius: f32) -> f32 {
  let k = vec3f(-0.92387953, 0.38268343, 0.41421356);
  var point = abs(pointValue);
  let firstEdge = vec2f(k.x, k.y);
  let secondEdge = vec2f(-k.x, k.y);
  point -= 2.0 * min(dot(firstEdge, point), 0.0) * firstEdge;
  point -= 2.0 * min(dot(secondEdge, point), 0.0) * secondEdge;
  point -= vec2f(clamp(point.x, -k.z * radius, k.z * radius), radius);
  return length(point) * sign(point.y);
}

fn sdOctagonalPrismZ(point: vec3f, radius: f32, halfDepth: f32) -> f32 {
  let d = vec2f(sdOctagon2(point.xy, radius), abs(point.z) - halfDepth);
  return min(max(d.x, d.y), 0.0) + length(max(d, vec2f(0.0)));
}

fn sdSegment2(point: vec2f, start: vec2f, end: vec2f) -> f32 {
  let pa = point - start;
  let ba = end - start;
  let projection = saturate(dot(pa, ba) / dot(ba, ba));
  return length(pa - ba * projection);
}

fn unionMaterial(a: vec2f, b: vec2f) -> vec2f {
  return select(b, a, a.x < b.x);
}

fn smoothTurn(time: f32, start: f32, duration: f32, turns: f32) -> f32 {
  let phase = saturate((time - start) / duration);
  let eased = phase * phase * (3.0 - 2.0 * phase);
  return TAU * turns * eased;
}

fn pulse(time: f32, start: f32, duration: f32) -> f32 {
  if (time < start || time > start + duration) {
    return 0.0;
  }
  let phase = (time - start) / duration;
  return pow(max(sin(PI * phase), 0.0), 0.35);
}

fn windowEase(time: f32, start: f32, end: f32, feather: f32) -> f32 {
  return smoothstep(start, start + feather, time) * (1.0 - smoothstep(end - feather, end, time));
}

fn pulseEnergy(time: f32) -> f32 {
  let first = pulse(time, 0.72, 0.42);
  let second = pulse(time, 1.30, 0.35);
  let third = pulse(time, 1.70, 0.39);
  let fourth = pulse(time, 2.13, 0.20);
  return max(max(first, second), max(third, fourth));
}

fn iceCharge(time: f32) -> f32 {
  return smoothstep(0.685, 0.735, time) * (1.0 - smoothstep(2.318, 2.333, time));
}

fn chestYaw(time: f32) -> f32 {
  var yaw = -0.43;
  yaw += smoothTurn(time, 0.72, 0.42, 1.0);
  yaw += smoothTurn(time, 1.30, 0.35, 1.0);
  yaw += smoothTurn(time, 1.70, 0.39, 1.0);
  yaw += smoothTurn(time, 2.13, 0.20, 0.5) * (1.0 - step(2.33, time));
  let finalPhase = saturate((time - 2.383) / 0.667);
  yaw += TAU * 2.0 * pow(finalPhase, 1.10);
  return yaw;
}

fn spinSpeed(time: f32, start: f32, duration: f32) -> f32 {
  if (time < start || time > start + duration) {
    return 0.0;
  }
  let phase = saturate((time - start) / duration);
  return 4.0 * phase * (1.0 - phase);
}

fn squeezeKick(time: f32, start: f32) -> f32 {
  let press = smoothstep(start - 0.035, start + 0.018, time);
  let release = 1.0 - smoothstep(start + 0.085, start + 0.155, time);
  return press * release;
}

fn finalSpinWindow(time: f32) -> f32 {
  return windowEase(time, 2.383, 3.06, 0.028);
}

fn chestSpinSpeed(time: f32) -> f32 {
  let firstSpeed = spinSpeed(time, 0.72, 0.42);
  let secondSpeed = spinSpeed(time, 1.30, 0.35);
  let thirdSpeed = spinSpeed(time, 1.70, 0.39);
  let fourthSpeed = spinSpeed(time, 2.13, 0.20);
  let finalRamp = saturate((time - 2.383) / 0.667);
  let finalSpeed = finalSpinWindow(time) * (0.72 + 0.28 * finalRamp);
  return max(max(max(firstSpeed, secondSpeed), max(thirdSpeed, fourthSpeed)), finalSpeed);
}

fn finalPressureAmount(time: f32) -> f32 {
  return smoothstep(2.50, 2.74, time) * (1.0 - smoothstep(2.76, 3.04, time));
}

fn chestPressureAmount(time: f32) -> f32 {
  let kick = max(
    max(squeezeKick(time, 0.72), squeezeKick(time, 1.30)),
    max(squeezeKick(time, 1.70), max(squeezeKick(time, 2.13), squeezeKick(time, 2.383)))
  );
  return saturate(
    chestSpinSpeed(time) * 0.26
      + kick * 0.34
      + finalSpinWindow(time) * 0.16
      + finalPressureAmount(time) * 0.82
  );
}

fn chestGrowthAmount(time: f32) -> f32 {
  return 1.0 + 0.42 * smoothstep(2.55, 3.14, time);
}

fn sampleChestArt(uv: vec2f, blur: f32) -> vec4f {
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    return vec4f(0.0);
  }

  let center = textureSampleLevel(chestTexture, chestSampler, uv, 0.0) * 0.36;
  let nearLeft = textureSampleLevel(chestTexture, chestSampler, uv - vec2f(blur, 0.0), 0.0) * 0.20;
  let nearRight = textureSampleLevel(chestTexture, chestSampler, uv + vec2f(blur, 0.0), 0.0) * 0.20;
  let farLeft = textureSampleLevel(chestTexture, chestSampler, uv - vec2f(blur * 2.35, 0.0), 0.0) * 0.12;
  let farRight = textureSampleLevel(chestTexture, chestSampler, uv + vec2f(blur * 2.35, 0.0), 0.0) * 0.12;
  return center + nearLeft + nearRight + farLeft + farRight;
}

fn renderTexturedChest(screen: vec2f, time: f32) -> vec4f {
  let yaw = chestYaw(time) + 0.43;
  let sideAmount = abs(sin(yaw));
  let backAmount = smoothstep(0.05, 0.88, -cos(yaw));
  let speed = chestSpinSpeed(time);
  let finalPressure = finalPressureAmount(time);
  let pressure = chestPressureAmount(time);

  // This comes from the exact DOM artwork box, so the WebGPU version cannot jump
  // in scale when it takes over from the loading fallback—even on Retina displays.
  let artHalfSize = params.chestHalfSize;
  let bobPixels = sin(time * 4.0) * 3.2 + sin(time * 7.0) * 1.8;
  let center = vec2f(0.0, 0.0152 - bobPixels * artHalfSize.y / 124.0);

  // The final spin grows, but the shape change is pressure-driven: shorter vertically,
  // wider through the middle, and only narrower when the chest turns edge-on.
  let growth = chestGrowthAmount(time);
  let heightScale = 1.0 - pressure * 0.17 - finalPressure * 0.25;
  let widthScale = (1.0 + pressure * 0.11 + finalPressure * 0.11) * mix(1.0, 0.72, sideAmount);
  var point = (screen - center) / (artHalfSize * growth * vec2f(widthScale, heightScale));

  let sideBulge = pressure * (1.0 - saturate(point.y * point.y));
  point.x /= 1.0 + sideBulge * (0.10 + finalPressure * 0.05);
  point.x += sin(yaw) * point.y * (0.035 + 0.075 * speed);
  point.y += sin(point.x * PI) * sin(yaw * 2.0) * pressure * 0.032;

  var texUv = vec2f(point.x * 0.5 + 0.5, 0.5 - point.y * 0.5);
  if (cos(yaw) < 0.0) {
    texUv.x = 1.0 - texUv.x;
  }

  let smear = speed * 0.016 + backAmount * 0.006;
  var art = sampleChestArt(texUv, smear);
  if (art.a <= 0.001) {
    return vec4f(0.0);
  }

  let energy = pulseEnergy(time);
  let ice = iceCharge(time) * (1.0 - smoothstep(2.34, 2.39, time));
  let finalCharge = smoothstep(2.41, 2.54, time);
  let luminance = dot(art.rgb, vec3f(0.2126, 0.7152, 0.0722));
  let icyArt = vec3f(0.75, 1.05, 1.28) + luminance * vec3f(0.90, 1.00, 1.10);
  let warmArt = art.rgb * vec3f(1.28, 0.72, 1.02) + vec3f(0.32, 0.10, 0.20);
  art = vec4f(mix(art.rgb, icyArt, saturate(ice * 0.70 + energy * 0.28)), art.a);
  art = vec4f(mix(art.rgb, warmArt, finalCharge * 0.70), art.a);
  let rotationalWash = saturate(backAmount * 0.70 + speed * 0.12 + finalPressure * 0.16);
  let washColor = mix(vec3f(0.64, 1.10, 1.48), vec3f(1.52, 0.44, 1.08), finalCharge);
  art = vec4f(mix(art.rgb, washColor * (0.42 + luminance), rotationalWash), art.a);
  art = vec4f(
    art.rgb
      + energy * vec3f(0.10, 0.28, 0.46)
      + finalPressure * vec3f(0.42, 0.16, 0.28)
      + finalCharge * vec3f(0.22, 0.16, 0.20),
    art.a
  );

  return art;
}

fn proxyVisibility(time: f32) -> f32 {
  let reset = windowEase(time, 2.326, 2.382, 0.009);
  return windowEase(time, 0.685, 3.29, 0.045) * (1.0 - reset);
}

fn chestScale(time: f32) -> f32 {
  return chestGrowthAmount(time);
}

fn mapChest(worldPoint: vec3f, time: f32) -> vec2f {
  let bob = 0.038 * sin(time * 4.0) + 0.022 * sin(time * 7.0);
  let growth = chestGrowthAmount(time);
  let pressure = chestPressureAmount(time);
  let finalPressure = finalPressureAmount(time);
  let heightScale = 1.0 - pressure * 0.17 - finalPressure * 0.25;
  let widthScale = 1.0 + pressure * 0.11 + finalPressure * 0.11;
  let depthScale = 1.0 + pressure * 0.07 + finalPressure * 0.08;
  var point = worldPoint;
  point.y -= bob;
  point = rotateY(point, -chestYaw(time));
  point /= growth * vec3f(widthScale, heightScale, depthScale);

  // Pressure travels inward from the top and bottom. The middle therefore swells
  // in both horizontal axes instead of behaving like a uniformly scaled box.
  let middle = 1.0 - saturate((point.y / 0.82) * (point.y / 0.82));
  let bulge = pressure * middle * (0.08 + finalPressure * 0.05);
  point = vec3f(point.x / (1.0 + bulge), point.y, point.z / (1.0 + bulge));

  var result = vec2f(1000.0, 0.0);

  // The two purple volumes establish the squat, faceted Lucky Chest silhouette.
  let body = sdRoundBox(point - vec3f(0.0, -0.27, 0.0), vec3f(1.00, 0.43, 0.60), 0.085);
  result = unionMaterial(result, vec2f(body, 1.0));

  let lid = sdRoundBox(point - vec3f(0.0, 0.40, 0.0), vec3f(1.02, 0.31, 0.61), 0.105);
  result = unionMaterial(result, vec2f(lid, 1.0));

  // Heavy rose-gold arches wrap all the way across the lid like the source model.
  let leftLidBrace = sdRoundBox(point - vec3f(-0.77, 0.39, 0.0), vec3f(0.17, 0.39, 0.67), 0.055);
  result = unionMaterial(result, vec2f(leftLidBrace, 2.0));

  let rightLidBrace = sdRoundBox(point - vec3f(0.77, 0.39, 0.0), vec3f(0.17, 0.39, 0.67), 0.055);
  result = unionMaterial(result, vec2f(rightLidBrace, 2.0));

  let centerBand = sdRoundBox(point - vec3f(0.0, 0.015, 0.0), vec3f(1.115, 0.095, 0.69), 0.028);
  result = unionMaterial(result, vec2f(centerBand, 2.0));

  let bandHighlight = sdRoundBox(point - vec3f(0.0, 0.108, 0.0), vec3f(1.08, 0.018, 0.701), 0.012);
  result = unionMaterial(result, vec2f(bandHighlight, 5.0));

  let bandLowerHighlight = sdRoundBox(point - vec3f(0.0, -0.078, 0.0), vec3f(1.08, 0.016, 0.701), 0.01);
  result = unionMaterial(result, vec2f(bandLowerHighlight, 5.0));

  let lowerRail = sdRoundBox(point - vec3f(0.0, -0.61, 0.0), vec3f(1.03, 0.055, 0.635), 0.025);
  result = unionMaterial(result, vec2f(lowerRail, 2.0));

  let lowerRailHighlight = sdRoundBox(point - vec3f(0.0, -0.555, 0.0), vec3f(1.00, 0.014, 0.646), 0.009);
  result = unionMaterial(result, vec2f(lowerRailHighlight, 5.0));

  // Lower corner columns, blocks and feet stay readable in the fast rotations.
  let leftLowerBrace = sdRoundBox(point - vec3f(-0.80, -0.34, 0.0), vec3f(0.13, 0.31, 0.665), 0.035);
  result = unionMaterial(result, vec2f(leftLowerBrace, 2.0));

  let rightLowerBrace = sdRoundBox(point - vec3f(0.80, -0.34, 0.0), vec3f(0.13, 0.31, 0.665), 0.035);
  result = unionMaterial(result, vec2f(rightLowerBrace, 2.0));

  let leftCorner = sdRoundBox(point - vec3f(-0.80, -0.54, 0.0), vec3f(0.205, 0.19, 0.69), 0.045);
  result = unionMaterial(result, vec2f(leftCorner, 2.0));

  let rightCorner = sdRoundBox(point - vec3f(0.80, -0.54, 0.0), vec3f(0.205, 0.19, 0.69), 0.045);
  result = unionMaterial(result, vec2f(rightCorner, 2.0));

  let leftFoot = sdRoundBox(point - vec3f(-0.79, -0.75, 0.47), vec3f(0.20, 0.10, 0.17), 0.028);
  result = unionMaterial(result, vec2f(leftFoot, 2.0));

  let rightFoot = sdRoundBox(point - vec3f(0.79, -0.75, 0.47), vec3f(0.20, 0.10, 0.17), 0.028);
  result = unionMaterial(result, vec2f(rightFoot, 2.0));

  let leftBackFoot = sdRoundBox(point - vec3f(-0.79, -0.75, -0.47), vec3f(0.20, 0.10, 0.17), 0.028);
  result = unionMaterial(result, vec2f(leftBackFoot, 2.0));

  let rightBackFoot = sdRoundBox(point - vec3f(0.79, -0.75, -0.47), vec3f(0.20, 0.10, 0.17), 0.028);
  result = unionMaterial(result, vec2f(rightBackFoot, 2.0));

  // Recessed violet side windows, each set inside a thick metallic surround.
  let leftSideFrame = sdRoundBox(point - vec3f(-1.025, 0.39, 0.0), vec3f(0.055, 0.27, 0.42), 0.08);
  result = unionMaterial(result, vec2f(leftSideFrame, 2.0));

  let leftSideInset = sdRoundBox(point - vec3f(-1.084, 0.39, 0.0), vec3f(0.032, 0.19, 0.30), 0.06);
  result = unionMaterial(result, vec2f(leftSideInset, 6.0));

  let rightSideFrame = sdRoundBox(point - vec3f(1.025, 0.39, 0.0), vec3f(0.055, 0.27, 0.42), 0.08);
  result = unionMaterial(result, vec2f(rightSideFrame, 2.0));

  let rightSideInset = sdRoundBox(point - vec3f(1.084, 0.39, 0.0), vec3f(0.032, 0.19, 0.30), 0.06);
  result = unionMaterial(result, vec2f(rightSideInset, 6.0));

  // Three stepped octagons reproduce the deep front lock rather than a flat badge.
  let lockBacking = sdOctagonalPrismZ(point - vec3f(0.0, -0.015, 0.675), 0.39, 0.075);
  result = unionMaterial(result, vec2f(lockBacking, 2.0));

  let lockRim = sdOctagonalPrismZ(point - vec3f(0.0, -0.015, 0.765), 0.345, 0.055);
  result = unionMaterial(result, vec2f(lockRim, 5.0));

  let lockInner = sdOctagonalPrismZ(point - vec3f(0.0, -0.015, 0.835), 0.285, 0.036);
  result = unionMaterial(result, vec2f(lockInner, 3.0));

  let topLeftGem = sdOctahedron(point - vec3f(-0.77, 0.69, 0.70), 0.145);
  result = unionMaterial(result, vec2f(topLeftGem, 4.0));

  let topRightGem = sdOctahedron(point - vec3f(0.77, 0.69, 0.70), 0.145);
  result = unionMaterial(result, vec2f(topRightGem, 4.0));

  let bottomLeftGem = sdOctahedron(point - vec3f(-0.80, -0.54, 0.72), 0.145);
  result = unionMaterial(result, vec2f(bottomLeftGem, 4.0));

  let bottomRightGem = sdOctahedron(point - vec3f(0.80, -0.54, 0.72), 0.145);
  result = unionMaterial(result, vec2f(bottomRightGem, 4.0));

  let backTopLeftGem = sdOctahedron(point - vec3f(-0.77, 0.69, -0.70), 0.145);
  result = unionMaterial(result, vec2f(backTopLeftGem, 4.0));

  let backTopRightGem = sdOctahedron(point - vec3f(0.77, 0.69, -0.70), 0.145);
  result = unionMaterial(result, vec2f(backTopRightGem, 4.0));

  result.x *= growth * min(heightScale, min(widthScale, depthScale));
  return result;
}

fn chestNormal(point: vec3f, time: f32) -> vec3f {
  let epsilon = 0.003;
  let x = vec3f(epsilon, 0.0, 0.0);
  let y = vec3f(0.0, epsilon, 0.0);
  let z = vec3f(0.0, 0.0, epsilon);
  return normalize(vec3f(
    mapChest(point + x, time).x - mapChest(point - x, time).x,
    mapChest(point + y, time).x - mapChest(point - y, time).x,
    mapChest(point + z, time).x - mapChest(point - z, time).x
  ));
}

fn raymarch(origin: vec3f, direction: vec3f, time: f32) -> vec3f {
  var distanceTravelled = 0.0;
  var material = 0.0;
  var hit = 0.0;

  for (var stepIndex = 0; stepIndex < 88; stepIndex += 1) {
    let samplePoint = origin + direction * distanceTravelled;
    let sampleData = mapChest(samplePoint, time);
    if (sampleData.x < 0.0025) {
      material = sampleData.y;
      hit = 1.0;
      break;
    }
    distanceTravelled += sampleData.x * 0.76;
    if (distanceTravelled > 12.0) {
      break;
    }
  }

  return vec3f(distanceTravelled, material, hit);
}

fn materialColor(material: f32) -> vec3f {
  if (material < 1.5) {
    return vec3f(0.47, 0.035, 0.64);
  }
  if (material < 2.5) {
    return vec3f(1.05, 0.42, 0.18);
  }
  if (material < 3.5) {
    return vec3f(0.37, 0.018, 0.56);
  }
  if (material < 4.5) {
    return vec3f(0.54, 0.015, 0.72);
  }
  if (material < 5.5) {
    return vec3f(1.34, 0.68, 0.24);
  }
  return vec3f(0.43, 0.15, 0.62);
}

fn renderChest(origin: vec3f, direction: vec3f, time: f32) -> vec4f {
  let march = raymarch(origin, direction, time);
  if (march.z < 0.5) {
    return vec4f(0.0);
  }

  let point = origin + direction * march.x;
  let normal = chestNormal(point, time);
  let lightDirection = normalize(vec3f(-0.43, 0.88, 0.58));
  let fillDirection = normalize(vec3f(0.75, 0.08, 0.52));
  let diffuse = max(dot(normal, lightDirection), 0.0);
  let fill = max(dot(normal, fillDirection), 0.0);
  let rim = pow(1.0 - max(dot(normal, -direction), 0.0), 2.25);
  let halfVector = normalize(lightDirection - direction);
  let isMetal = select(0.0, 1.0, (march.y > 1.5 && march.y < 2.5) || (march.y > 4.5 && march.y < 5.5));
  let specularPower = mix(34.0, 72.0, isMetal);
  let specular = pow(max(dot(normal, halfVector), 0.0), specularPower);

  var base = materialColor(march.y);
  let energy = pulseEnergy(time);
  let ice = iceCharge(time);
  let finalCharge = smoothstep(2.41, 2.50, time);
  let coolLevel = max(energy, ice * 0.58) * (1.0 - finalCharge);
  let blueWhite = vec3f(0.88, 1.54, 1.92);
  let warmWhite = vec3f(1.42, 0.74, 1.02);
  base = mix(base, blueWhite, coolLevel * 0.88);
  base = mix(base, warmWhite, finalCharge * 0.64);

  var color = base * (0.27 + diffuse * 0.86 + fill * 0.20);
  color += rim * mix(vec3f(0.35, 0.82, 1.28), vec3f(1.30, 0.30, 0.90), finalCharge) * (0.25 + coolLevel * 1.25 + finalCharge * 1.2);
  color += specular * mix(vec3f(0.88, 0.82, 1.0), vec3f(1.75, 0.90, 0.42), isMetal) * (0.72 + isMetal * 0.48);
  color += energy * vec3f(0.34, 0.70, 0.96);

  if (march.y > 2.5 && march.y < 3.5) {
    let bob = 0.038 * sin(time * 4.0) + 0.022 * sin(time * 7.0);
    var questionPoint = point;
    questionPoint.y -= bob;
    let localPoint = rotateY(questionPoint, -chestYaw(time)) / chestScale(time);
    let lockUv = vec2f(localPoint.x, localPoint.y + 0.01);
    var questionDistance = sdSegment2(lockUv, vec2f(-0.105, 0.075), vec2f(-0.065, 0.145));
    questionDistance = min(questionDistance, sdSegment2(lockUv, vec2f(-0.065, 0.145), vec2f(0.045, 0.145)));
    questionDistance = min(questionDistance, sdSegment2(lockUv, vec2f(0.045, 0.145), vec2f(0.105, 0.082)));
    questionDistance = min(questionDistance, sdSegment2(lockUv, vec2f(0.105, 0.082), vec2f(0.070, 0.012)));
    questionDistance = min(questionDistance, sdSegment2(lockUv, vec2f(0.070, 0.012), vec2f(0.010, -0.040)));
    questionDistance = min(questionDistance, length(lockUv - vec2f(0.0, -0.145)) - 0.025);
    let question = 1.0 - smoothstep(0.020, 0.035, questionDistance);
    let questionColor = mix(vec3f(1.62, 0.72, 0.25), vec3f(0.72, 1.48, 1.78), coolLevel);
    color = mix(color, mix(questionColor, vec3f(1.68, 0.94, 1.22), finalCharge), question);
  }

  return vec4f(color, 1.0);
}

fn starMask(point: vec2f, radius: f32) -> f32 {
  let k1 = vec2f(0.80901699, -0.58778525);
  let k2 = vec2f(-k1.x, k1.y);
  var p = point;
  p.x = abs(p.x);
  p -= 2.0 * max(dot(k1, p), 0.0) * k1;
  p -= 2.0 * max(dot(k2, p), 0.0) * k2;
  p.x = abs(p.x);
  p.y -= radius;
  let edge = 0.48 * vec2f(-k1.y, k1.x) - vec2f(0.0, 1.0);
  let projection = clamp(dot(p, edge) / dot(edge, edge), 0.0, radius);
  let distanceToStar = length(p - edge * projection) * sign(p.y * edge.x - p.x * edge.y);
  return 1.0 - smoothstep(-0.004, 0.004, distanceToStar);
}

fn rainbow(angle: f32) -> vec3f {
  return 0.52 + 0.48 * cos(vec3f(0.0, 2.1, 4.2) + angle);
}

fn chargePulse(screen: vec2f, time: f32, start: f32, duration: f32, ringEnd: f32) -> vec3f {
  let phase = saturate((time - start) / duration);
  let isActive = step(start, time) * (1.0 - step(start + duration, time));
  let energy = isActive * pow(max(sin(PI * phase), 0.0), 0.70);
  let point = (screen - vec2f(0.0, -0.015)) / vec2f(1.0, 0.84);
  let radius = length(point);
  let angle = atan2(point.y, point.x);

  let ringLife = isActive * smoothstep(0.0, 0.06, phase) * (1.0 - smoothstep(0.08, ringEnd, phase));
  let ringRadius = mix(0.45, 0.70, smoothstep(0.0, 0.58, phase));
  let primaryRing = exp(-245.0 * (radius - ringRadius) * (radius - ringRadius));
  let echoOne = exp(-320.0 * (radius - ringRadius + 0.055) * (radius - ringRadius + 0.055));
  let echoTwo = exp(-420.0 * (radius - ringRadius + 0.105) * (radius - ringRadius + 0.105));
  let rainbowBand = rainbow(angle + phase * 2.2 + 0.45);

  let spokePattern = pow(max(cos(angle * 8.0 + phase * 6.0), 0.0), 11.0);
  let spokes = spokePattern * exp(-1.85 * radius) * energy;
  let core = exp(-4.0 * radius * radius) * energy;

  let streakY = point.y + 0.004 * sin(point.x * 15.0 + phase * 7.0);
  let thinStreak = exp(-520.0 * streakY * streakY) * exp(-1.4 * abs(point.x)) * energy;
  let upperStreak = exp(-780.0 * (streakY - 0.105) * (streakY - 0.105)) * exp(-1.7 * abs(point.x)) * energy;
  let lowerStreak = exp(-720.0 * (streakY + 0.11) * (streakY + 0.11)) * exp(-1.65 * abs(point.x)) * energy;

  let softShell = exp(-58.0 * (radius - ringRadius) * (radius - ringRadius));
  var result = rainbowBand * (primaryRing * 1.2 + echoOne * 0.52 + echoTwo * 0.24 + softShell * 0.25) * ringLife * 2.45;
  result += vec3f(0.42, 0.12, 1.05) * primaryRing * ringLife * 0.42;
  result += vec3f(0.18, 0.92, 1.62) * core * 1.30;
  result += mix(vec3f(0.19, 0.80, 1.55), rainbowBand, 0.35) * spokes * 0.70;
  result += vec3f(0.43, 1.18, 1.75) * (thinStreak + upperStreak * 0.48 + lowerStreak * 0.42) * 0.82;
  return result;
}

fn orbitTrail(screen: vec2f, time: f32, start: f32, duration: f32, warmth: f32) -> vec3f {
  let phase = saturate((time - start) / duration);
  let activity = step(start, time) * (1.0 - step(start + duration, time));
  let life = activity * smoothstep(0.07, 0.18, phase) * (1.0 - smoothstep(0.80, 0.98, phase));
  let eased = phase * phase * (3.0 - 2.0 * phase);
  let trailColor = mix(vec3f(0.22, 1.18, 1.82), vec3f(1.70, 0.32, 1.08), warmth);
  let highlightColor = mix(vec3f(0.72, 1.62, 1.94), vec3f(1.82, 1.02, 0.48), warmth);
  var result = vec3f(0.0);

  for (var index = 0; index < 3; index += 1) {
    let lane = f32(index);
    let center = vec2f(0.025 + 0.018 * sin(eased * TAU + lane * 1.7), -0.035 + (lane - 1.0) * 0.045);
    let radii = vec2f(0.50 + lane * 0.07, 0.115 + lane * 0.026);
    let orbitPoint = (screen - center) / radii;
    let radius = length(orbitPoint);
    let angle = atan2(orbitPoint.y, orbitPoint.x);
    let head = -TAU * eased + lane * 1.55 + 0.35;
    let delta = atan2(sin(angle - head), cos(angle - head));
    let fineBand = exp(-920.0 * (radius - 1.0) * (radius - 1.0));
    let softBand = exp(-185.0 * (radius - 1.0) * (radius - 1.0));
    let rightReveal = 0.23 + 0.77 * smoothstep(-0.45, 0.35, orbitPoint.x);
    let comet = exp(-1.45 * delta * delta);
    let laneStrength = 1.0 - lane * 0.17;
    result += trailColor * fineBand * rightReveal * (0.20 + 0.80 * comet) * laneStrength * 1.34;
    result += highlightColor * softBand * rightReveal * comet * laneStrength * 0.24;
  }

  return result * life;
}

fn foregroundOrbit(screen: vec2f, time: f32, start: f32, duration: f32, warmth: f32) -> vec3f {
  let phase = saturate((time - start) / duration);
  let activity = step(start, time) * (1.0 - step(start + duration, time));
  let life = activity * smoothstep(0.10, 0.20, phase) * (1.0 - smoothstep(0.76, 0.97, phase));
  let eased = phase * phase * (3.0 - 2.0 * phase);
  let point = screen - vec2f(0.01, -0.045);
  let orbitPoint = point / vec2f(0.53, 0.135);
  let radius = length(orbitPoint);
  let angle = atan2(orbitPoint.y, orbitPoint.x);
  let head = -TAU * eased + 0.55;
  let delta = atan2(sin(angle - head), cos(angle - head));
  let band = exp(-1050.0 * (radius - 1.0) * (radius - 1.0));
  let frontHalf = 1.0 - smoothstep(-0.72, 0.03, orbitPoint.y);
  let comet = exp(-1.25 * delta * delta);
  let linePoint = screen - vec2f(0.0, -0.015 + 0.014 * sin(eased * TAU));
  let horizontal = exp(-820.0 * linePoint.y * linePoint.y) * exp(-1.25 * abs(linePoint.x));
  let trailColor = mix(vec3f(0.50, 1.38, 1.86), vec3f(1.76, 0.46, 1.12), warmth);
  return trailColor * (band * frontHalf * (0.15 + 0.85 * comet) * 0.92 + horizontal * 0.28) * life;
}

fn renderRewardBurst(screen: vec2f, time: f32) -> vec3f {
  let rewardPhase = smoothstep(3.52, 3.72, time);
  let radialPoint = screen - vec2f(0.0, 0.02);
  let radialAngle = atan2(radialPoint.y, radialPoint.x);
  let radialDistance = length(radialPoint);
  let radialDirection = radialPoint / max(radialDistance, 0.001);
  let horizontal = saturate(radialDirection.x * 0.5 + 0.5);
  let verticalDirection = saturate(radialDirection.y * 0.5 + 0.5);
  let upperColor = mix(vec3f(1.90, 1.52, 0.12), vec3f(0.25, 1.48, 0.66), horizontal);
  let lowerColor = mix(vec3f(1.44, 0.22, 1.02), vec3f(0.27, 0.62, 1.48), horizontal);
  let rewardColor = mix(lowerColor, upperColor, verticalDirection);
  let broadBeam = pow(max(cos(radialAngle * 9.0 + sin(radialAngle * 4.0)), 0.0), 5.0);
  let fineBeam = pow(max(cos(radialAngle * 15.0 - 0.8), 0.0), 12.0);
  let centerWhite = exp(-2.8 * radialDistance * radialDistance);
  var burst = rewardColor * (0.72 + broadBeam * 1.18 + fineBeam * 0.72) * exp(-0.20 * radialDistance);
  burst += vec3f(1.40, 1.28, 1.56) * centerWhite * 1.12;
  return burst * rewardPhase;
}

fn addSparkles(color: vec3f, screen: vec2f, time: f32, fade: f32) -> vec3f {
  var result = color;
  for (var index = 0; index < 18; index += 1) {
    let seed = f32(index) + 1.0;
    let x = (hash11(seed * 2.7) - 0.5) * 1.65;
    let y = -0.28 + hash11(seed * 5.9) * 1.25;
    let twinkle = 0.28 + 0.72 * pow(0.5 + 0.5 * sin(time * (1.5 + hash11(seed) * 2.0) + seed), 5.0);
    let distanceToSpark = length(screen - vec2f(x, y));
    let spark = exp(-1850.0 * distanceToSpark * distanceToSpark) * twinkle * fade;
    result += spark * mix(vec3f(0.40, 0.77, 1.0), vec3f(1.0, 0.94, 0.64), hash11(seed * 8.1));
  }
  return result;
}

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let time = params.time;
  let aspect = params.resolution.x / max(params.resolution.y, 1.0);
  let screen = vec2f((uv.x - 0.5) * aspect, 0.5 - uv.y) * 1.9;
  let rewardPhase = smoothstep(3.52, 3.72, time);

  var color = renderRewardBurst(screen, time);
  color = addSparkles(color, screen, time, 1.0);

  let energy = pulseEnergy(time);
  let ice = iceCharge(time);
  let finalCharge = smoothstep(2.41, 2.50, time) * (1.0 - smoothstep(3.16, 3.26, time));
  let earlyFinalFlare = windowEase(time, 2.41, 2.76, 0.05);
  let lateFinalFlare = smoothstep(2.88, 3.14, time);
  let finalEffect = finalCharge * mix(0.28, 1.0, max(earlyFinalFlare, lateFinalFlare));
  color += chargePulse(screen, time, 0.70, 0.44, 0.24);
  color += chargePulse(screen, time, 1.27, 0.38, 0.24);
  color += chargePulse(screen, time, 1.67, 0.42, 0.24);
  color += chargePulse(screen, time, 2.12, 0.21, 0.55);
  color += orbitTrail(screen, time, 0.72, 0.42, 0.0);
  color += orbitTrail(screen, time, 1.30, 0.35, 0.0);
  color += orbitTrail(screen, time, 1.70, 0.39, 0.0);
  color += orbitTrail(screen, time, 2.13, 0.20, 0.0);

  let haloDistance = length((screen - vec2f(0.0, -0.01)) / vec2f(1.0, 0.82));
  let halo = exp(-5.2 * haloDistance * haloDistance) * (energy * 1.18 + ice * 0.22 + finalEffect * 1.45);
  color += halo * mix(vec3f(0.14, 0.72, 1.35), vec3f(1.45, 0.22, 0.85), smoothstep(2.41, 2.66, time));

  let rayPoint = screen - vec2f(0.0, -0.02);
  let rayAngle = atan2(rayPoint.y, rayPoint.x);
  let rayDistance = length(rayPoint);
  let wideRays = pow(max(cos(rayAngle * 7.0 + sin(rayAngle * 3.0) + time * 1.4), 0.0), 2.8);
  let fineRays = pow(max(cos(rayAngle * 13.0 - time * 2.2), 0.0), 6.5);
  let finalRayColor = mix(vec3f(1.36, 0.34, 1.04), vec3f(1.20, 1.02, 0.34), 0.42 + 0.22 * sin(rayAngle * 3.0 + 0.6));
  color += (wideRays * 0.40 + fineRays * 0.20) * finalEffect * exp(-0.58 * rayDistance) * finalRayColor;
  let goldRays = pow(max(cos(rayAngle * 5.0 - time * 1.1 + 0.8), 0.0), 4.0);
  color += goldRays * finalEffect * exp(-0.62 * rayDistance) * vec3f(1.24, 0.92, 0.34) * 0.30;

  let finalHorizontal = exp(-460.0 * rayPoint.y * rayPoint.y) * exp(-0.9 * abs(rayPoint.x));
  let finalUpper = exp(-620.0 * (rayPoint.y - 0.12) * (rayPoint.y - 0.12)) * exp(-1.1 * abs(rayPoint.x));
  color += (finalHorizontal + finalUpper * 0.42) * finalEffect * vec3f(1.80, 0.63, 1.03);

  let texturedChest = renderTexturedChest(screen, time);
  let cameraOrigin = vec3f(0.0, 0.18, 5.05);
  let cameraTarget = vec3f(0.0, 0.02, 0.0);
  let forward = normalize(cameraTarget - cameraOrigin);
  let right = normalize(cross(forward, vec3f(0.0, 1.0, 0.0)));
  let up = cross(right, forward);
  let rayDirection = normalize(forward + right * screen.x * 0.80 + up * screen.y * 0.80);
  let volumetricChest = renderChest(cameraOrigin, rayDirection, time);

  // The exact art owns camera-facing angles. True ray-marched geometry owns the
  // side and back, so the spin has real depth without changing the chest's identity.
  let relativeYaw = chestYaw(time) + 0.43;
  let cameraFacing = max(cos(relativeYaw), 0.0);
  let spinActivity = saturate(max(chestSpinSpeed(time), finalSpinWindow(time)));
  let modelMix = spinActivity * (1.0 - smoothstep(0.70, 0.82, cameraFacing));
  let texturedWeight = texturedChest.a * (1.0 - modelMix);
  let volumetricWeight = volumetricChest.a * modelMix;
  let chestAlpha = saturate(texturedWeight + volumetricWeight);
  var chest = vec4f(0.0);
  if (chestAlpha > 0.001) {
    let chestColor = (
      texturedChest.rgb * texturedWeight + volumetricChest.rgb * volumetricWeight
    ) / max(texturedWeight + volumetricWeight, 0.001);
    chest = vec4f(chestColor, chestAlpha);
  }
  let chestVisibility = (1.0 - rewardPhase) * (1.0 - smoothstep(3.18, 3.43, time));
  color = mix(color, chest.rgb, chest.a * chestVisibility);

  color += foregroundOrbit(screen, time, 0.72, 0.42, 0.0);
  color += foregroundOrbit(screen, time, 1.30, 0.35, 0.0);
  color += foregroundOrbit(screen, time, 1.70, 0.39, 0.0);
  color += foregroundOrbit(screen, time, 2.13, 0.20, 0.0);
  let finalFrontLine = exp(-560.0 * rayPoint.y * rayPoint.y) * exp(-1.0 * abs(rayPoint.x));
  color += finalFrontLine * finalEffect * vec3f(1.42, 0.58, 1.08) * 0.48;

  let centerFlash = exp(-7.0 * dot(screen, screen)) * finalEffect * finalEffect;
  color += centerFlash * vec3f(1.35, 0.72, 1.02) * 2.35;

  let whiteoutIn = smoothstep(3.06, 3.23, time);
  let whiteoutOut = 1.0 - smoothstep(3.52, 3.63, time);
  let whiteout = whiteoutIn * whiteoutOut * exp(-2.4 * dot(screen, screen));
  let vignettePoint = vec2f((uv.x - 0.5) * 1.06, (uv.y - 0.5) * 0.92);
  let vignette = smoothstep(0.84, 0.24, dot(vignettePoint, vignettePoint));
  color *= mix(0.82, 1.0, vignette);
  color = color / (color + vec3f(0.68));
  color = pow(color, vec3f(0.86));
  color = mix(color, vec3f(1.0), whiteout);

  let effectAlpha = saturate(max(color.r, max(color.g, color.b)) * 0.82);
  let chestCoverage = chest.a * chestVisibility;
  let alpha = 1.0 - (1.0 - effectAlpha) * (1.0 - chestCoverage);
  return vec4f(color * params.intensity * alpha, alpha);
}

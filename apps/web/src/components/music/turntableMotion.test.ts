import assert from "node:assert/strict";
import { test } from "node:test";

import {
  advanceTurntable, createTurntableMotion, PARKED_ARM_ANGLE, recordDragDelta, RECORD_SPEED,
  type TurntableMotionInput,
} from "./turntableMotion.ts";

const playing: TurntableMotionInput = { playing: true, dragging: false, reducedMotion: false, progress: 0.4 };

test("playback starts the motor, lowers the arm, and follows track progress", () => {
  const motion = createTurntableMotion();
  for (let i = 0; i < 300; i += 1) advanceTurntable(motion, playing, 1 / 60);
  assert.equal(motion.speed, RECORD_SPEED);
  assert.equal(motion.armLift, 0);
  const earlierAngle = motion.armAngle;
  for (let i = 0; i < 300; i += 1) advanceTurntable(motion, { ...playing, progress: 0.9 }, 1 / 60);
  assert.ok(motion.armAngle < earlierAngle, "the stylus moves toward the center as the track progresses");
});

test("stopping playback settles the motor and parks the arm, then stops requesting frames", () => {
  const motion = createTurntableMotion();
  motion.speed = RECORD_SPEED;
  motion.armAngle = -0.5;
  motion.armLift = 0;
  for (let i = 0; i < 300; i += 1) advanceTurntable(motion, { ...playing, playing: false }, 1 / 60);
  const rotation = motion.rotation;
  assert.equal(advanceTurntable(motion, { ...playing, playing: false }, 1 / 60), false);
  assert.equal(motion.rotation, rotation);
  assert.equal(motion.speed, 0);
  assert.equal(motion.armAngle, PARKED_ARM_ANGLE);
  assert.equal(motion.armLift, 0.12);
});

test("holding the vinyl suspends motor rotation until the hand releases it", () => {
  const motion = createTurntableMotion();
  motion.rotation = 0.8;
  motion.speed = -12;
  for (let i = 0; i < 100; i += 1) advanceTurntable(motion, { ...playing, dragging: true }, 1 / 60);
  assert.equal(motion.rotation, 0.8);
  assert.equal(motion.armLift, 0.12);
  advanceTurntable(motion, playing, 1 / 60);
  assert.ok(motion.rotation < 0.8);
  assert.ok(motion.speed > -12, "the hand's momentum eases back to the motor speed");
});

test("reduced motion stops automatic movement without undoing manual vinyl rotation", () => {
  const motion = createTurntableMotion();
  motion.rotation = 1.2;
  motion.speed = -12;
  assert.equal(advanceTurntable(motion, { ...playing, reducedMotion: true }, 1 / 60), false);
  assert.equal(motion.rotation, 1.2);
  assert.equal(motion.speed, 0);
  assert.equal(motion.armLift, 0);
  assert.equal(advanceTurntable(motion, { ...playing, playing: false, reducedMotion: true }, 1 / 60), false);
  assert.equal(motion.armAngle, PARKED_ARM_ANGLE);
});

test("scrubbing across the angular seam works in both directions", () => {
  const delta = recordDragDelta(Math.PI - 0.05, -Math.PI + 0.05);
  assert.ok(Math.abs(delta + 0.1) < 1e-10);
  assert.ok(Math.abs(recordDragDelta(-Math.PI + 0.05, Math.PI - 0.05) - 0.1) < 1e-10);
});

test("an old playback timestamp cannot push the stylus past the inner groove", () => {
  const motion = createTurntableMotion();
  advanceTurntable(motion, { ...playing, reducedMotion: true, progress: 10 }, 1 / 60);
  assert.equal(motion.armAngle, -0.73);
  advanceTurntable(motion, { ...playing, reducedMotion: true, progress: -1 }, 1 / 60);
  assert.equal(motion.armAngle, -0.38);
});

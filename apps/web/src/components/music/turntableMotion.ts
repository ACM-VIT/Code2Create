export type TurntableMotion = {
  rotation: number;
  speed: number;
  armAngle: number;
  armLift: number;
};

export type TurntableMotionInput = {
  playing: boolean;
  dragging: boolean;
  reducedMotion: boolean;
  progress: number;
};

export const RECORD_SPEED = -(Math.PI * 2 * (100 / 3)) / 60;
export const PARKED_ARM_ANGLE = 0.28;

export function createTurntableMotion(): TurntableMotion {
  return { rotation: 0, speed: 0, armAngle: PARKED_ARM_ANGLE, armLift: 0.12 };
}

/** Cross the pointer's ±π seam without making the vinyl jump a full turn. */
export function recordDragDelta(previous: number, next: number) {
  return -Math.atan2(Math.sin(next - previous), Math.cos(next - previous));
}

/** Advance the motor and cueing arm; return whether another frame is needed. */
export function advanceTurntable(
  motion: TurntableMotion,
  input: TurntableMotionInput,
  deltaSeconds: number,
) {
  const delta = Math.min(0.05, Math.max(0, deltaSeconds));
  const progress = Math.min(1, Math.max(0, input.progress));
  const armAngle = input.playing ? -0.38 - progress * 0.35 : PARKED_ARM_ANGLE;
  const armLift = input.playing && !input.dragging ? 0 : 0.12;

  if (input.reducedMotion) {
    motion.speed = 0;
    motion.armAngle = armAngle;
    motion.armLift = armLift;
    return false;
  }

  if (!input.dragging) {
    const targetSpeed = input.playing ? RECORD_SPEED : 0;
    motion.speed += (targetSpeed - motion.speed) * (1 - Math.exp(-4 * delta));
    if (Math.abs(motion.speed - targetSpeed) < 0.002) motion.speed = targetSpeed;
    motion.rotation = (motion.rotation + motion.speed * delta) % (Math.PI * 2);
  }

  motion.armAngle += (armAngle - motion.armAngle) * (1 - Math.exp(-5 * delta));
  motion.armLift += (armLift - motion.armLift) * (1 - Math.exp(-8 * delta));
  if (Math.abs(motion.armAngle - armAngle) < 0.0001) motion.armAngle = armAngle;
  if (Math.abs(motion.armLift - armLift) < 0.0001) motion.armLift = armLift;

  return (
    (!input.dragging && motion.speed !== 0) ||
    motion.armAngle !== armAngle ||
    motion.armLift !== armLift
  );
}

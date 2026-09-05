import type { GameState, QuarterTurn, ShapeType } from "./types";

export const SETTLE_MS = 1000;
export const LINEAR_SPEED_LIMIT = 0.18;
export const ANGULAR_SPEED_LIMIT = 0.02;
export const POINTS_PER_PIECE = 100;
export const INITIAL_LIVES = 3;
export const CAMERA_TRIGGER_RATIO = 0.5;
export const AIM_MOVE_STEP = 8;

export const INITIAL_GAME_STATE: GameState = {
  phase: "aiming",
  score: 0,
  rotation: 0,
  settleStartedAt: null
};

export function rotateQuarterTurn(turn: QuarterTurn): QuarterTurn {
  return ((turn + 1) % 4) as QuarterTurn;
}

export function clampSpawnX(x: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, x));
}

export function dropPiece(state: GameState): GameState {
  if (state.phase !== "aiming") return state;
  return { ...state, phase: "falling", settleStartedAt: null };
}

export function updateSettlement(
  state: GameState,
  touching: boolean,
  linearSpeed: number,
  angularSpeed: number,
  now: number
): GameState {
  if (state.phase === "gameOver" || state.phase === "aiming" || state.phase === "locked") {
    return state;
  }

  const stable =
    touching &&
    linearSpeed <= LINEAR_SPEED_LIMIT &&
    Math.abs(angularSpeed) <= ANGULAR_SPEED_LIMIT;

  if (!stable) return { ...state, phase: "falling", settleStartedAt: null };

  const startedAt = state.settleStartedAt ?? now;
  if (now - startedAt >= SETTLE_MS) {
    return { ...state, phase: "locked", settleStartedAt: startedAt };
  }

  return { ...state, phase: "settling", settleStartedAt: startedAt };
}

export function lockPiece(state: GameState): GameState {
  if (state.phase !== "locked" || state.settleStartedAt === null) return state;
  return { ...state, score: state.score + POINTS_PER_PIECE, settleStartedAt: null };
}

export function loseLife(lives: number): number {
  return Math.max(0, Math.floor(lives) - 1);
}

export function getEndlessCameraTargetY(
  currentCameraY: number,
  stackTopY: number,
  viewportHeight: number,
  triggerRatio: number = CAMERA_TRIGGER_RATIO
): number {
  const triggerY = currentCameraY + viewportHeight * triggerRatio;
  if (stackTopY > triggerY) return currentCameraY;
  return Math.min(currentCameraY, stackTopY - viewportHeight * triggerRatio);
}

export function hasPieceMissed(bodyCenterY: number, failureBoundary: number): boolean {
  return bodyCenterY > failureBoundary;
}

export function restartGame(): GameState {
  return { ...INITIAL_GAME_STATE };
}

export function pickShape(random: number = Math.random()): ShapeType {
  const normalized = Math.min(0.999999, Math.max(0, random));
  if (normalized < 0.5) return "logo";
  if (normalized < 0.75 || normalized >= 0.99) return "petal";
  if (normalized < 0.8) return "origami";
  if (normalized < 0.9) return "lantern";
  return "butterfly";
}

const SHAPES: readonly ShapeType[] = ["logo", "petal", "origami", "lantern", "butterfly"];

export function drawShapeFromBag(bag: readonly ShapeType[], random: number = Math.random()): { shape: ShapeType; bag: ShapeType[] } {
  const available = bag.length ? [...bag] : [...SHAPES];
  const index = Math.min(available.length - 1, Math.max(0, Math.floor(random * available.length)));
  const [shape] = available.splice(index, 1);
  // `SHAPES` is never empty, so the splice always yields one; the fallback is
  // for the type rather than for a case the bag can reach.
  return { shape: shape ?? "logo", bag: available };
}

export type ShapeType = "logo" | "petal" | "origami" | "lantern" | "butterfly";
export type GamePhase = "aiming" | "falling" | "settling" | "locked" | "clearing" | "gameOver";
export type QuarterTurn = 0 | 1 | 2 | 3;

export interface GameState {
  phase: GamePhase;
  score: number;
  rotation: QuarterTurn;
  settleStartedAt: number | null;
}

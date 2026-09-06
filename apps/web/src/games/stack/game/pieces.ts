import type { QuarterTurn, ShapeType } from "./types";
import type { Body } from "matter-js";
import { createPhysicsBody } from "./physics";

export { PIECE_STYLES, type PieceStyle } from "./pieceStyles";

export function createPieceBody(
  type: ShapeType,
  x: number,
  y: number,
  turn: QuarterTurn
): Body {
  return createPhysicsBody(type, x, y, turn);
}

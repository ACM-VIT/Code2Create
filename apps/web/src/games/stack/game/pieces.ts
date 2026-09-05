import type { QuarterTurn, ShapeType } from "./types";
import type { Body } from "matter-js";
import { createPhysicsBody } from "./physics";

export interface PieceStyle {
  fill: string;
  stroke: string;
  accent: string;
  renderWidth: number;
}

export const PIECE_STYLES: Record<ShapeType, PieceStyle> = {
  logo: { fill: "#2c2c2c", stroke: "#f4b8d0", accent: "#d37fa2", renderWidth: 94 },
  petal: { fill: "#d884a2", stroke: "#fbe2ec", accent: "#ffffff", renderWidth: 74 },
  origami: { fill: "#d99a63", stroke: "#fbe2ec", accent: "#fff0dc", renderWidth: 124 },
  // The replacement SVG is tall (520 x 620); this width keeps its total
  // rendered height in the same normalized footprint as the other pieces.
  lantern: { fill: "#e56f8f", stroke: "#ffd4df", accent: "#ffe3a8", renderWidth: 77 },
  butterfly: { fill: "#8da9dc", stroke: "#e5edff", accent: "#f5b3cf", renderWidth: 102 }
};

export function createPieceBody(
  type: ShapeType,
  x: number,
  y: number,
  turn: QuarterTurn
): Body {
  return createPhysicsBody(type, x, y, turn);
}

import level from "../level.json" with { type: "json" };

/** Cell codes used by the level editor export in `level.json`. */
export const CELL = {
  /** Off-board filler the editor writes around the maze: never walkable, never drawn. */
  VOID: 0,
  PATH: 1,
  WALL: 2,
  GHOST_HOUSE: 3,
  TELEPORT: 4,
  POWER_PELLET: 5,
  PACMAN_SPAWN: 6,
  GHOST_SPAWN: 7,
} as const;

export type CellCode = (typeof CELL)[keyof typeof CELL];

const CELL_CODES: readonly number[] = Object.values(CELL);

function isCellCode(value: number): value is CellCode {
  return CELL_CODES.includes(value);
}

/** `level.json` is checked as it is read, so a stray editor code fails here and not mid-game. */
function parseCell(value: number, row: number, col: number): CellCode {
  if (isCellCode(value)) return value;
  throw new Error(`level.json holds an unknown cell code ${value} at (${row},${col})`);
}

export const MAZE: readonly (readonly CellCode[])[] = level.map.map((line, row) =>
  line.map((value, col) => parseCell(value, row, col)),
);

export const MAZE_ROWS = MAZE.length;
export const MAZE_COLS = MAZE[0]?.length ?? 0;

/** The code at (row, col); anything off the grid reads as off-board filler. */
export const cellAt = (row: number, col: number): CellCode => MAZE[row]?.[col] ?? CELL.VOID;

/** Paired tunnel openings, as {x: col, y: row} endpoints. */
export const TELEPORTS = level.teleports;

/** Cells outside the grid count as open so the outer border draws an outline. */
export function isWall(row: number, col: number): boolean {
  if (row < 0 || row >= MAZE_ROWS || col < 0 || col >= MAZE_COLS) return false;
  return cellAt(row, col) === CELL.WALL;
}

const TELEPORT_PARTNER = new Map(
  TELEPORTS.flatMap(({ endpoints }) => {
    // `level.json` pairs every teleport, so both mouths are present.
    const [a, b] = endpoints;
    if (!a || !b) throw new Error("level.json lists a teleport without both mouths");
    return [
      [`${a.y},${a.x}`, b],
      [`${b.y},${b.x}`, a],
    ] as const;
  }),
);

export type Tile = { row: number; col: number };
/** Unit step as [dRow, dCol]; [0, 0] is standing still. */
export type Dir = readonly [number, number];

/** Every tile carrying `code`, in row-major order. */
export function tilesOf(code: CellCode): Tile[] {
  return MAZE.flatMap((line, row) =>
    line.flatMap((cell, col) => (cell === code ? [{ row, col }] : [])),
  );
}

export const key = (t: Tile) => `${t.row},${t.col}`;

/** The first tile carrying `code`; the map must place at least one. */
export function firstTile(code: CellCode): Tile {
  const tile = tilesOf(code)[0];
  if (!tile) throw new Error(`level.json places no tile with code ${code}`);
  return tile;
}

export const PACMAN_SPAWN: Tile = firstTile(CELL.PACMAN_SPAWN);

/** True while `t` is inside the ghost house (Pac-Man can never enter; ghosts can, until they've left it once). */
export const house = (t: Tile) => cellAt(t.row, t.col) === CELL.GHOST_HOUSE;

/**
 * The tile reached by moving one step from (row, col), or null if the grid edge,
 * a wall, off-board filler or (unless `houseOk`) the ghost house blocks it.
 *
 * Stepping onto a teleport mouth emerges at its partner, so a pair works wherever
 * it sits: the endpoints need not be on the border, and need not face each other.
 * You never come to rest on a mouth, so arriving at one can't bounce you back.
 */
export function step(
  row: number,
  col: number,
  dRow: number,
  dCol: number,
  houseOk = false,
): Tile | null {
  let r = row + dRow;
  let c = col + dCol;
  if (r < 0 || r >= MAZE_ROWS || c < 0 || c >= MAZE_COLS) return null;
  const partner = cellAt(r, c) === CELL.TELEPORT && TELEPORT_PARTNER.get(`${r},${c}`);
  if (partner) {
    r = partner.y;
    c = partner.x;
  }
  const t = { row: r, col: c };
  const cell = cellAt(r, c);
  const blocked = cell === CELL.WALL || cell === CELL.VOID;
  return blocked || (!houseOk && house(t)) ? null : t;
}

/**
 * Resolve Pac-Man's next tile and facing from what the player wants and where
 * he's already going.
 *
 * Arcade Pac-Man doesn't stop-and-turn: he keeps going until the wanted turn
 * opens up, takes it instantly, and if nothing's open stops but keeps facing the
 * way he was headed. `want` is taken whenever it is a real direction and `step`
 * finds that way open — a straight reversal included, as on the cabinet, where a
 * 180 is legal anywhere and is how you break off a chase. Anything else carries
 * on along `dir`, staying put if that's a wall. A `want` of [0, 0] means
 * "nothing asked for" (no key yet, or the press aged out — see TURN_BUFFER) and
 * falls through to the same carry-on.
 *
 * Only ever called on a tile boundary, so a reversal costs a tile of travel like
 * any other turn rather than flipping him mid-step.
 */
export function advance(pos: Tile, want: Dir, dir: Dir): { pos: Tile; dir: Dir } {
  const turned = (want[0] || want[1]) ? step(pos.row, pos.col, ...want) : null;
  if (turned) return { pos: turned, dir: want };
  return { pos: step(pos.row, pos.col, ...dir) ?? pos, dir };
}

import { TELEPORTS, key, type Tile } from "../game/index.ts";
import { ASSET_BASE } from "../assets.ts";

/** Inline position for a `.sprite` sitting on `t`. */
export const at = (t: Tile) => ({
  top: `calc(${t.row} * var(--maze-cell))`,
  left: `calc(${t.col} * var(--maze-cell))`,
});

export const FACE: Record<string, string> = { "-1,0": "up", "1,0": "down", "0,-1": "left", "0,1": "right" };

/** A `.sprite` div for one maze tile, showing `src` as its background image. */
export const sprite = (t: Tile, src: string, className = "sprite", k = key(t)) => (
  <div key={k} className={className} style={{ ...at(t), backgroundImage: `url(${src})` }} />
);

/**
 * Artwork per teleport pair, indexed the way `level.json` lists them, so both
 * mouths of a pair share a look and a player can tell which one leads where.
 * Cycled if a map ever adds more pairs than there are files.
 */
const PORTAL_ART = [
  `${ASSET_BASE}/Portal2.svg`,
  `${ASSET_BASE}/Portal1.svg`,
  `${ASSET_BASE}/Portal3.svg`,
] as const;
const [FIRST_PORTAL_ART] = PORTAL_ART;

/** Every teleport mouth on the board, with the artwork of the pair it belongs to. */
export const PORTALS: { tile: Tile; src: string }[] = TELEPORTS.flatMap(({ endpoints }, i) =>
  endpoints.map((e) => ({ tile: { row: e.y, col: e.x }, src: PORTAL_ART[i % PORTAL_ART.length] ?? FIRST_PORTAL_ART })),
);

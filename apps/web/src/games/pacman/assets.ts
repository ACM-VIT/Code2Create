/**
 * Where the ported Pac-Man artwork and audio sit under the site root.
 *
 * The upstream game was a standalone Next app and loaded these from `/`. They
 * are namespaced here so the portal's own `public/` stays legible. Stylesheet
 * and Tailwind arbitrary-value URLs cannot read this constant, so `games.css`
 * and the one `bg-[url(...)]` class repeat the literal path.
 */
export const ASSET_BASE = "/games/pacman";

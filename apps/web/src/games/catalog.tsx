import { gameCatalog, type GameKey } from '@code2create/domain'
import { lazy, type ComponentType, type LazyExoticComponent } from 'react'

/**
 * The playable games, in the order the arcade lists them.
 *
 * The server-side half of a game — its title and the score bound it is held to
 * — lives in the domain catalogue, which the backend also reads. This file adds
 * only what the browser needs: the board itself and a line of copy. Adding a
 * game is an entry in each, and nothing else.
 *
 * Boards are lazy so the arcade's artwork and game loop stay out of the portal's
 * first load; nobody pays for Pac-Man on their way to writing an idea.
 */
export type GameBoardProps = {
  /** Called once with the round's score the moment a round ends. */
  onRoundEnd: (score: number) => void
}

export type GameEntry = {
  readonly key: GameKey
  readonly title: string
  readonly blurb: string
  readonly Board: LazyExoticComponent<ComponentType<GameBoardProps>>
}

const boards: Record<GameKey, LazyExoticComponent<ComponentType<GameBoardProps>>> = {
  pacman: lazy(() =>
    import('./pacman/Map.tsx').then((module) => ({ default: module.default })),
  ),
}

const blurbs: Record<GameKey, string> = {
  pacman: 'Clear the maze, dodge the ghosts, and eat them while the power pellet lasts.',
}

export const games: readonly GameEntry[] = gameCatalog.map((game) => ({
  key: game.key,
  title: game.title,
  blurb: blurbs[game.key],
  Board: boards[game.key],
}))

/** The catalogue entry for `key`, or null when the key is not a published game. */
export function gameEntry(key: string): GameEntry | null {
  return games.find((game) => game.key === key) ?? null
}

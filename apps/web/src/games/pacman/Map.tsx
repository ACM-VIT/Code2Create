import { useCallback, useEffect, useRef, useState } from "react";
import {
  CELL,
  DOTS,
  FRIGHT,
  FRUIT_SPAWN,
  GHOSTS,
  MAZE,
  MAZE_COLS,
  MAZE_ROWS,
  cleared,
  fruitOut,
  key,
  type Tile,
} from "./game/index.ts";
import { setMuted, setVolume, useSounds } from "./ui/audio.ts";
import { useGame } from "./ui/input.ts";
import { PX, drawMaze } from "./ui/canvas.ts";
import { FACE, PORTALS, at, sprite } from "./ui/sprites.tsx";
import { ASSET_BASE } from "./assets.ts";
import "./pacman.css";

/**
 * Sprite timing, in ticks (= frames at 60 Hz). `GHOST_FRAME` is ticks per ghost
 * leg-animation frame (8, as the arcade); `FLASH` is ticks per colour while a
 * frightened ghost flashes white (12 gives the arcade's ~5 flashes in the
 * 2-second warning).
 */
const GHOST_FRAME = 8;
const FLASH = 12;

/** The board: ticks the game, plays its sounds, and draws the maze, dots, fruit, ghosts and Pac-Man. */
export default function Map({ onRoundEnd }: { onRoundEnd?: (score: number) => void }) {
  const { game, started, start, restart } = useGame();
  useSounds(game);
  const [quiet, setQuiet] = useState(false);
  const [vol, setVol] = useState(1);
  const silent = quiet || !vol; // what the icon shows: "you will hear nothing", whichever control caused it
  const { pos, dir } = game;
  const left = (t: Tile) => !game.eaten.has(key(t));
  // A ref callback rather than a mount effect: the board is unmounted by the end screen and
  // mounted again by PLAY AGAIN, and the walls have to be painted onto each new canvas node.
  const canvas = useCallback((el: HTMLCanvasElement | null) => {
    if (el) drawMaze(el);
  }, []);

  const done = cleared(game);
  const over = !game.lives || done;
  // The round's score is reported once, on the tick the board ends. The ref
  // resets when PLAY AGAIN starts a fresh game, so each round reports its own.
  const reported = useRef(false);
  useEffect(() => {
    if (!over) {
      reported.current = false;
      return;
    }
    if (reported.current) return;
    reported.current = true;
    onRoundEnd?.(game.score);
  }, [game.score, onRoundEnd, over]);

  if (over) {
    return (
      <div className="font-arcade text-center">
        <p className={`text-2xl sm:text-4xl ${done ? "text-[#00ff00]" : "text-[#ffb7c5]"}`}>
          {done ? "GAME COMPLETED" : "GAME OVER"}
        </p>
        <p className="mt-8 text-base text-white sm:text-2xl">SCORE {game.score}</p>
        <button
          type="button"
          onClick={restart}
          className="mt-8 cursor-pointer border-2 border-[#F1CEDF] px-4 py-2 text-base text-[#F1CEDF] hover:bg-[#F1CEDF] hover:text-black active:translate-y-px sm:text-xl"
        >
          PLAY AGAIN
        </button>
      </div>
    );
  }

  return (
    <div className="pacman-game" style={{ "--maze-cell": "clamp(6px, min(3vw, 3vh), 26px)" } as React.CSSProperties}>
    <div className="relative bg-black">
      <canvas
        ref={canvas}
        width={MAZE_COLS * PX}
        height={MAZE_ROWS * PX}
        role="img"
        aria-label="Pac-Man maze"
        className="block"
        style={{
          width: `calc(${MAZE_COLS} * var(--maze-cell))`,
          height: `calc(${MAZE_ROWS} * var(--maze-cell))`,
        }}
      />
      {PORTALS.map(({ tile, src }) => (
        <div key={key(tile)} className="portal" style={{ ...at(tile), backgroundImage: `url(${src})` }} />
      ))}
      {DOTS.pellets.filter(left).map((t) => sprite(t, `${ASSET_BASE}/pellet.svg`, "sprite pellet"))}
      {DOTS.power.filter(left).map((t) => sprite(t, `${ASSET_BASE}/power-pellet.svg`, "sprite power"))}
      {fruitOut(game) && sprite(FRUIT_SPAWN, `${ASSET_BASE}/cherry.svg`, "sprite cherry")}
      {game.ghosts.map((gh, i) => {
        const frame = Math.floor(game.t / GHOST_FRAME) & 1;
        const face = FACE[String(gh.dir)] ?? "up";
        const src =
          gh.mode === "eyes" ? `eyes-${face}`
          : gh.mode === "normal" ? `${GHOSTS[i]!.name}-${face}-${frame}`
          : game.fright <= FRIGHT.flash && Math.floor(game.t / FLASH) & 1 ? `scared-white-${frame}`
          : `scared-${frame}`;
        const { name } = GHOSTS[i]!;
        if (!gh.out) {
          // Still in the house: bob half a tile towards the pocket's other row and back, facing the way it goes.
          // Keyed on `out` rather than release, so the two ghosts released at 0 dots also bob until they actually leave.
          const down = MAZE[gh.pos.row + 1]![gh.pos.col] === CELL.GHOST_HOUSE;
          const [go, back] = down ? ["down", "up"] : ["up", "down"];
          // Half a cycle of delay on the second ghost of each pocket (GHOSTS lists a pocket's
          // pair together, so those are the odd indexes) starts it at the far end of the drift:
          // the two then pass each other, one rising as the other falls, faces included.
          const bob = {
            "--bob": down ? "50%" : "-50%",
            "--go": `url(${ASSET_BASE}/ghosts/${name}-${go}-0.svg)`,
            "--back": `url(${ASSET_BASE}/ghosts/${name}-${back}-1.svg)`,
            animationDelay: i % 2 ? "-0.5s" : "0s",
          };
          return <div key={name} className="sprite bob" style={{ ...at(gh.pos), ...bob } as React.CSSProperties} />;
        }
        // The ghost just eaten stays hidden behind its points during the freeze.
        const hidden = game.bite && gh.mode === "eyes" && key(gh.pos) === key(game.bite.pos);
        return !hidden && sprite(gh.pos, `${ASSET_BASE}/ghosts/${src}.svg`, "sprite", name);
      })}
      {game.bite && (
        <span className="sprite grid place-items-center font-arcade text-[#33ffff] text-[length:calc(var(--maze-cell)/2.5)]" style={at(game.bite.pos)}>
          {game.bite.points}
        </span>
      )}
      <div className="absolute bottom-full left-0 mb-2 flex items-center gap-2">
        <button
          type="button"
          aria-label={quiet ? "Unmute" : "Mute"}
          aria-pressed={quiet}
          onClick={() => { setMuted(!quiet); setQuiet(!quiet); }}
          onPointerUp={(e) => e.currentTarget.blur()} // give the keys back to the game after a click
          className="size-9 cursor-pointer bg-contain bg-center bg-no-repeat opacity-80 hover:opacity-100 active:translate-y-px"
          style={{ backgroundImage: `url(${ASSET_BASE}/sound-${silent ? "off" : "on"}.svg)` }}
        />
        <input
          type="range"
          aria-label="Volume"
          min={0}
          max={1}
          step={0.1}
          value={vol}
          onChange={(e) => {
            const v = e.currentTarget.valueAsNumber;
            setVolume(v);
            setVol(v);
            if (quiet) { setMuted(false); setQuiet(false); } // reaching for the slider means "let me hear it"
          }}
          onPointerUp={(e) => e.currentTarget.blur()}
          className="volume h-3 w-20"
          style={{ "--fill": `${vol * 100}%` } as React.CSSProperties}
        />
      </div>
      <output aria-label="Score" className="absolute right-0 bottom-full pb-2 font-mono text-2xl text-white">
        {game.score}
      </output>
      <div
        role="img"
        aria-label="Pac-Man"
        className="sprite pacman"
        hidden={!!game.bite}
        style={{
          ...at(pos),
          // Sprite faces right at 0deg; atan2 turns [dRow, dCol] into that heading.
          rotate: `${(Math.atan2(dir[0], dir[1]) * 180) / Math.PI}deg`,
        }}
      />
      {!started && (
        <button
          type="button"
          aria-label="Play"
          onClick={start}
          className="group absolute inset-0 z-10 grid cursor-pointer place-items-center bg-[#F1CEDF]/40 backdrop-blur-[3px]"
        >
          <span className="play size-[calc(var(--maze-cell)*4)] rounded-full bg-[#F1CEDF] shadow-[0_0_var(--maze-cell)_#F1CEDF] transition-transform group-hover:scale-110 group-active:scale-95" />
        </button>
      )}
    </div>
    <ul aria-label="Lives" className="flex gap-2 p-2">
      {Array.from({ length: game.lives }, (_, i) => (
        <li key={i} className="size-(--maze-cell) bg-[url(/games/pacman/heart.svg)] bg-contain bg-no-repeat" />
      ))}
    </ul>
    </div>
  );
}

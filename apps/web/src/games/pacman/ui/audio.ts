import { useEffect, useRef } from "react";
import { FRUIT_SPAWN, cleared, key, type Game } from "../game/index.ts";
import { ASSET_BASE } from "../assets.ts";

/** Every Audio element ever started through `sound`, so `stopAll` can silence the game in one go. */
const playing = new Set<HTMLAudioElement>();

/**
 * Whether the player has silenced the game, and how loud it is otherwise.
 *
 * These live at module scope because `setMuted`/`setVolume` must reach sounds
 * that don't exist yet — the siren created three minutes into a muted game has
 * to come out silent too. `Map` mirrors both in state, which is what re-renders
 * the controls. Kept as two values rather than one so un-muting returns you to
 * the volume you had set rather than to full blast.
 */
let muted = false;
let volume = 1;

/**
 * Silence or restore the game, now and for every sound made later.
 *
 * `.muted` rather than `.pause()`: the siren and chomp loops stay in step with
 * the game while silent, so unmuting is instant and restarts nothing mid-note.
 */
export const setMuted = (on: boolean) => {
  muted = on;
  playing.forEach((a) => (a.muted = on));
};

/** Set the game's volume (0..1), now and for every sound made later. */
export const setVolume = (v: number) => {
  volume = v;
  playing.forEach((a) => (a.volume = v));
};

/** True while the game is muted; read by `useGame` so a muted start doesn't wait out a silent jingle. */
export const isMuted = () => muted;

export const sound = (name: string) => {
  const a = new Audio(`${ASSET_BASE}/sounds/${name}`);
  a.muted = muted; // born silent if the player has already hit mute
  a.volume = volume;
  playing.add(a);
  a.addEventListener("ended", () => playing.delete(a)); // one-shots drop out once they finish
  return a;
};

const play = (name: string) => {
  void sound(name).play().catch(() => {});
};

/** Pauses and rewinds every sound the game has going, one-shots and loops alike. */
export const stopAll = () => {
  playing.forEach((a) => { a.pause(); a.currentTime = 0; });
  playing.clear();
};

/**
 * Ticks the chomp loop keeps playing after a dot. Ticks are frames, and a
 * dot lands every ~9 of them while eating, so "a dot this tick" alone would
 * flicker between tiles; 12 bridges the gap without trailing on.
 */
const CHOMP_HOLD = 12;

/** Arcade sounds off the change between ticks: one-shots for events, loops for the siren and chomping. */
export function useSounds(game: Game) {
  const prev = useRef(game);
  const ate = useRef(-Infinity); // tick of the last dot eaten
  const loops = useRef<Record<string, HTMLAudioElement>>({});
  useEffect(() => {
    const p = prev.current;
    prev.current = game;
    // The game just ended, win or lose: cut everything and start nothing new. The loops go
    // with it, so a new game builds its own — `stopAll` has dropped these from the set that
    // `setMuted`/`setVolume` reach, and a reused one would ignore both controls.
    if (!game.lives || cleared(game)) { stopAll(); loops.current = {}; return; }
    const loop = (name: string, on: boolean) => {
      loops.current[name] ??= Object.assign(sound(name), { loop: true });
      const a = loops.current[name];
      if (!on) a.pause();
      else if (a.paused) a.play().catch(() => {});
    };
    if (game.lives < p.lives) play("die.mp3");
    // `game.t > p.t` keeps this to a life actually won mid-game: PLAY AGAIN also raises the
    // count, off a board whose clock has just gone back to 0, and that is not an extra life.
    if (game.lives > p.lives && game.t > p.t) play("extra-lives.mp3");
    if (game.bite && !p.bite) play("eatghost.mp3");
    if (game.fright > p.fright) play("eatpill.mp3");
    if (p.fruit && !game.fruit && key(game.pos) === key(FRUIT_SPAWN)) play("eatfruit.wav");
    if (game.t < p.t) ate.current = -Infinity; // a death reset the clock
    if (game.eaten.size > p.eaten.size) ate.current = game.t;
    loop("eating.mp3", game.t - ate.current < CHOMP_HOLD);
    loop("siren.mp3", game.t > 0 && game.lives > 0 && !cleared(game) && !game.bite); // one siren throughout: the arcade's frightened siren is not reproduced
  }, [game]);
  useEffect(() => () => Object.values(loops.current).forEach((a) => a.pause()), []);
}

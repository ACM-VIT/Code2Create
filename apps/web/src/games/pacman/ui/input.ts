import { useCallback, useEffect, useRef, useState } from "react";
import { NEW_GAME, TICK_MS, TURN_BUFFER, tick, type Dir } from "../game/index.ts";
import { isMuted, sound, stopAll } from "./audio.ts";

/** The "not moving" direction: what the sim is asked for while no movement key is down. */
const STOP: Dir = [0, 0];

const KEYS: Record<string, Dir> = {
  arrowup: [-1, 0], w: [-1, 0],
  arrowdown: [1, 0], s: [1, 0],
  arrowleft: [0, -1], a: [0, -1],
  arrowright: [0, 1], d: [0, 1],
};

/**
 * Most real time (ms) the tick loop will make up in one animation frame. A
 * background tab gets no frames; on return the loop would otherwise run seconds
 * of ticks at once and Pac-Man would die off-screen. Capping at a few ticks'
 * worth means a long gap just pauses the game instead.
 */
const MAX_CATCH_UP_MS = 4 * TICK_MS;

/**
 * Game state, advanced on a fixed step; the keyboard and direction pad set where Pac-Man
 * wants to go. The board waits behind its play overlay until `start` is called,
 * which plays the opening jingle; ticking starts when it ends.
 *
 * Input is modelled on the cabinet's joystick: a held key or direction button
 * is a held stick, asking for that turn at every corner until let go, and a
 * tap is a flick the sim honours for `TURN_BUFFER` ticks — which is what lets a
 * player turn a corner without hitting the exact frame. `held` keeps the inputs
 * still down, oldest first, so the newest one wins.
 *
 * A fixed-step accumulator over `requestAnimationFrame` rather than
 * `setInterval`, because browsers round timer delays to whole milliseconds
 * (16.67 -> 16, i.e. 4% fast) and throttle them in hidden tabs; frames track the
 * display clock exactly and simply stop while the tab is hidden.
 */
export function useGame() {
  const [game, setGame] = useState(NEW_GAME);
  const [started, setStarted] = useState(false);
  const want = useRef(STOP);
  const pressed = useRef(-Infinity); // performance.now() of the last press, for TURN_BUFFER
  const go = useRef(false);
  // Movement inputs still down, oldest first: the newest is what is being asked
  // for. A ref rather than an effect-local array so `restart` can clear it — a
  // key still held through PLAY AGAIN would otherwise steer the fresh board.
  const held = useRef<{ id: string; direction: Dir }[]>([]);

  const press = useCallback((id: string, direction: Dir) => {
    if (!held.current.some((input) => input.id === id)) held.current.push({ id, direction });
    want.current = direction;
    pressed.current = performance.now();
  }, []);

  const release = useCallback((id: string) => {
    const index = held.current.findIndex((input) => input.id === id);
    if (index >= 0) held.current.splice(index, 1);
  }, []);

  /** Play the opening jingle; ticking starts when it ends. */
  const open = useCallback(() => {
    if (isMuted()) go.current = true; // nothing to listen to: don't sit out a silent jingle
    else {
      const jingle = sound("opening_song.mp3");
      jingle.addEventListener("ended", () => (go.current = true), { once: true });
      jingle.play().catch(() => (go.current = true)); // audio blocked: just start
    }
  }, []);

  /** Take the play overlay down and open the game. Ignored once running. */
  const start = useCallback(() => {
    if (started) return;
    setStarted(true);
    open();
  }, [started, open]);

  /**
   * Deal a fresh board and put the play overlay back up: the play-again button on the end
   * screens returns you to the board as it was before the first game, waiting on play,
   * rather than setting anything running.
   */
  const restart = useCallback(() => {
    stopAll(); // whatever the end of the last game left running shouldn't carry into the new board
    setGame(NEW_GAME);
    setStarted(false);
    want.current = STOP;
    pressed.current = -Infinity;
    held.current.length = 0;
    go.current = false; // nothing ticks again until the play button opens the next game
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && e.target.tagName === "INPUT") return; // the volume slider owns its own arrow keys
      const k = e.key.toLowerCase();
      const d = KEYS[k];
      if (!d) return;
      press(`key:${k}`, d);
      e.preventDefault();
    };
    const onUp = (e: KeyboardEvent) => {
      release(`key:${e.key.toLowerCase()}`);
    };
    const onBlur = () => (held.current.length = 0); // a key held while the tab loses focus never fires keyup
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onUp);
    window.addEventListener("blur", onBlur);
    let raf = 0;
    let last = performance.now();
    let owed = 0;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (go.current) owed = Math.min(owed + now - last, MAX_CATCH_UP_MS); // a hidden tab shouldn't fast-forward on return
      last = now;
      const n = Math.floor(owed / TICK_MS);
      owed -= n * TICK_MS;
      if (!n) return;
      // The newest press wins for TURN_BUFFER ticks — long enough to reach the corner it was meant for —
      // then whatever key is still down takes over (a held key asks for its turn at every corner).
      const newest = held.current.at(-1);
      const asked = now - pressed.current < TURN_BUFFER * TICK_MS ? want.current
        : newest?.direction ?? STOP;
      setGame((g) => {
        let next = g;
        for (let i = 0; i < n; i++) next = tick(next, asked);
        return next;
      });
    };
    raf = requestAnimationFrame(frame);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", onBlur);
      cancelAnimationFrame(raf);
    };
  }, [press, release]);

  return { game, started, start, restart, press, release };
}

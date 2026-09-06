/**
 * The colour game's clock.
 *
 * These are the parts of a round a player cannot hurry: the beats before it
 * opens, and the time the colour is held. They live apart from the board so the
 * catalogue's plausibility bound can be checked against them — see
 * `timing.test.ts`.
 */

/** How long the target is held before it is taken away. */
export const memoriseMs = 3_000;

/** The beats of "ready · set · go" before a round opens. */
export const countdownBeats = ["ready", "set", "go"] as const;
export const beatMs = 620;

/** The rounds a player waits through before the game can end. */
export const roundsAfterTheFirst = 4;

/**
 * The soonest a run can possibly finish, measured the way the server measures it.
 *
 * The run opens on the first colour submitted, so the first round's countdown
 * and memorising happen before the clock starts. Every round after it is inside
 * the clock, and none of them can be cut short.
 */
export const fastestRunMs = roundsAfterTheFirst * (countdownBeats.length * beatMs + memoriseMs);

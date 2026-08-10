import { Vibration } from 'react-native'

/**
 * Makes an open page felt as well as seen.
 *
 * Push wakes a phone that is closed. This is the other half: a phone that is
 * unlocked and in a hand or on a table, where the page arrives over the live
 * query and would otherwise appear in silence — which is exactly the moment
 * somebody is not looking at the screen, because they are working.
 *
 * It vibrates rather than plays a tone. A tone needs an asset, a volume a
 * reviewer cannot change without leaving the page, and it loses to a hall loud
 * enough that people are shouting; a vibration is felt through a pocket, needs
 * no permission, and is not silenced by the ringer switch.
 *
 * Deliberately the platform's own vibration rather than a haptics library:
 * this is a pager, so it wants the blunt buzz a phone makes for a call, not a
 * taptic tuned to be ignorable. It also keeps the alarm free of native modules,
 * so it works in any build rather than only after the next one.
 */

/** Buzz, gap, buzz — the shape of a phone asking rather than informing. */
const pattern = [0, 600, 400, 600]

/** Long enough not to buzz continuously, short enough not to be missed. */
const beatMs = 3_000

let timer: ReturnType<typeof setInterval> | null = null

/**
 * Starts the alarm, or leaves it running if it already is.
 *
 * Safe to call on every render: a page that is still open should keep the same
 * beat rather than restart it and drift.
 */
export function startPagerAlarm() {
  if (timer !== null) return
  const beat = () => Vibration.vibrate(pattern)
  beat()
  timer = setInterval(beat, beatMs)
}

/** Stops it. Idempotent, so answering twice is not an error. */
export function stopPagerAlarm() {
  if (timer === null) return
  clearInterval(timer)
  timer = null
  Vibration.cancel()
}

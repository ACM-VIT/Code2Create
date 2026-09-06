/**
 * Pairing a played round with the run the server opened for it.
 *
 * The two halves race. A run is opened when play starts, but the round can end
 * before that round trip finishes — a first-piece miss or an instant death
 * beats it easily — so the score has to wait for the run rather than be dropped
 * because the id has not landed yet. Holding the promise instead of the id it
 * resolves to is what makes that waiting possible.
 *
 * Kept out of the screen so the ordering can be tested without a browser.
 */
export interface RoundRecorder {
  /** Open the run this round will be reported against. */
  start: () => void
  /** Report a finished round, once its run has been opened. */
  end: (score: number) => void
}

export function createRoundRecorder<Id>({
  openRun,
  recordRound,
  onError,
}: {
  openRun: () => Promise<Id>
  recordRound: (round: { score: number; runId: Id }) => Promise<void>
  /** Called when a round could not be recorded, with the cause. */
  onError: (cause: unknown) => void
}): RoundRecorder {
  let pending: Promise<Id> | null = null

  return {
    start() {
      const opening = openRun()
      // The round's end reports the failure. This only keeps a rejection that
      // nobody is waiting on yet from surfacing as an unhandled one.
      opening.catch(() => undefined)
      pending = opening
    },

    end(score) {
      const opening = pending
      if (!opening) return // no run was opened: nothing to report this round against
      pending = null // a run is spent once, and the server agrees
      void opening
        .then((runId) => recordRound({ score, runId }))
        .catch((cause: unknown) => onError(cause))
    },
  }
}

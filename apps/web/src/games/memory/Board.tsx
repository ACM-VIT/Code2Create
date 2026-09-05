import { useCallback, useEffect, useRef, useState } from 'react'

import {
  concealMismatch,
  createGame,
  matchedPairs,
  PAIR_COUNT,
  selectCard,
  type Card,
  type MemoryGame,
} from './game/engine.ts'
import { roundScore } from './game/score.ts'

const assetBase = '/games/memory'
const mismatchRevealMs = 900

function formatTime(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, '0')
  const seconds = Math.floor(totalSeconds % 60)
    .toString()
    .padStart(2, '0')
  return `${minutes}:${seconds}`
}

/** One reading on the control row, in the arcade's own type. */
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col leading-tight">
      <span className="text-[10.5px] font-semibold tracking-[.08em] text-fg/50">{label}</span>
      <span className="font-mono text-[15px] text-fg/85">{value}</span>
    </div>
  )
}

/**
 * A control on the board's one row.
 *
 * The background is set explicitly because the portal loads Tailwind's
 * utilities without its preflight, so a button otherwise keeps the browser's
 * own grey.
 */
function ControlButton({
  children,
  onClick,
  disabled = false,
}: {
  children: string
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded-petal-sm border-2 border-petal-line bg-transparent px-3 py-1.5 font-ui text-[13px] text-fg/70 transition-colors hover:border-petal-edge hover:bg-rose-light/10 hover:text-fg disabled:opacity-40 disabled:hover:border-petal-line disabled:hover:bg-transparent disabled:hover:text-fg/70"
    >
      {children}
    </button>
  )
}

/**
 * The memory board: twelve pairs face down, matched two at a time.
 *
 * The arcade ranks one number per round, so a finished board is scored on how
 * few moves and seconds it took — see `game/score.ts`. An unfinished board
 * reports nothing, because a round that was abandoned is not a result.
 *
 * Ported from the standalone page, which carried its own header, brand mark and
 * font. Here the screen around it supplies all three, so the board is only the
 * grid and one row of controls.
 */
export default function Board({
  onRoundStart,
  onRoundEnd,
}: {
  onRoundStart?: () => void
  onRoundEnd?: (score: number) => void
}) {
  const [game, setGame] = useState<MemoryGame>(() => createGame())
  const [elapsed, setElapsed] = useState(0)
  const [paused, setPaused] = useState(false)

  // The clock runs from the first card turned to the last pair found. A ref
  // because the tick reads it every second without re-subscribing.
  const startedAt = useRef<number | null>(null)
  const bankedMs = useRef(0)
  const reported = useRef(false)
  const opened = useRef(false)

  const complete = game.status === 'complete'
  const pairs = matchedPairs(game)

  /** Wall-clock seconds of play, not counting time spent paused. */
  const seconds = useCallback(() => {
    const running = startedAt.current === null ? 0 : Date.now() - startedAt.current
    return Math.floor((bankedMs.current + running) / 1000)
  }, [])

  useEffect(() => {
    if (complete || paused || startedAt.current === null) return
    const tick = window.setInterval(() => setElapsed(seconds()), 250)
    return () => window.clearInterval(tick)
  }, [complete, paused, seconds])

  // The round's score is reported once, on the move that finishes the board.
  useEffect(() => {
    if (!complete || reported.current) return
    reported.current = true
    if (startedAt.current !== null) {
      bankedMs.current += Date.now() - startedAt.current
      startedAt.current = null
    }
    const finishedIn = Math.floor(bankedMs.current / 1000)
    setElapsed(finishedIn)
    onRoundEnd?.(roundScore({ moves: game.moves, seconds: finishedIn }))
  }, [complete, game.moves, onRoundEnd])

  const newGame = useCallback(() => {
    setGame(createGame())
    setElapsed(0)
    setPaused(false)
    startedAt.current = null
    bankedMs.current = 0
    reported.current = false
    opened.current = false
  }, [])

  const togglePause = useCallback(() => {
    if (complete || startedAt.current === null) {
      // Nothing is running yet, so there is nothing to pause.
      if (!paused) return
    }
    setPaused((wasPaused) => {
      if (wasPaused) {
        startedAt.current = Date.now()
        return false
      }
      if (startedAt.current !== null) {
        bankedMs.current += Date.now() - startedAt.current
        startedAt.current = null
      }
      return true
    })
  }, [complete, paused])

  const choose = useCallback(
    (cardId: string) => {
      if (paused) return
      const result = selectCard(game, cardId)
      if (result.event.type === 'ignored') return

      // The run the round is reported against opens with the first card, not
      // when the board is dealt: a board nobody touches is not a round.
      if (!opened.current) {
        opened.current = true
        startedAt.current = Date.now()
        onRoundStart?.()
      }
      setGame(result.state)

      if (result.event.type === 'mismatch') {
        window.setTimeout(() => setGame((current) => concealMismatch(current)), mismatchRevealMs)
      }
    },
    [game, onRoundStart, paused],
  )

  return (
    <div className="flex w-full flex-col items-center gap-4">
      {/* Pause, new game and the readings share one line. */}
      <div className="flex w-full max-w-[520px] flex-wrap items-center justify-between gap-x-5 gap-y-3">
        <div className="flex items-center gap-2">
          <ControlButton onClick={togglePause} disabled={complete || !opened.current}>
            {paused ? 'Resume' : 'Pause'}
          </ControlButton>
          <ControlButton onClick={newGame}>New game</ControlButton>
        </div>
        <div className="flex items-center gap-5">
          <Stat label="PAIRS" value={`${pairs}/${PAIR_COUNT}`} />
          <Stat label="MOVES" value={String(game.moves)} />
          <Stat label="TIME" value={formatTime(elapsed)} />
        </div>
      </div>

      <div className="relative">
        <div
          className="grid grid-cols-4 gap-2 sm:grid-cols-6 sm:gap-2.5"
          role="grid"
          aria-label="Memory cards"
        >
          {game.cards.map((card, index) => (
            <MemoryCard
              key={card.id}
              card={card}
              position={index + 1}
              disabled={paused || card.isMatched}
              onSelect={() => choose(card.id)}
            />
          ))}
        </div>

        {paused ? (
          <div className="absolute inset-0 grid place-items-center rounded-petal-sm bg-black/70 backdrop-blur-sm">
            <p className="font-ui text-[15px] text-rose-light">Paused</p>
          </div>
        ) : null}
      </div>

      {complete ? (
        <p className="text-center text-[12.5px] text-fg/70">
          All {PAIR_COUNT} pairs in{' '}
          <span className="font-mono text-fg/90">{game.moves}</span> moves and{' '}
          <span className="font-mono text-fg/90">{formatTime(elapsed)}</span>.
        </p>
      ) : null}
    </div>
  )
}

function MemoryCard({
  card,
  position,
  disabled,
  onSelect,
}: {
  card: Card
  position: number
  disabled: boolean
  onSelect: () => void
}) {
  const label = card.isMatched
    ? `Card ${position}: ${card.motif}, matched`
    : card.isFaceUp
      ? `Card ${position}: ${card.motif}, face up`
      : `Card ${position}, face down`
  const shown = card.isFaceUp || card.isMatched

  return (
    <button
      type="button"
      role="gridcell"
      aria-label={label}
      disabled={disabled}
      onClick={onSelect}
      className={`grid size-[62px] place-items-center rounded-petal-sm border-2 bg-transparent transition-colors sm:size-[72px] ${
        card.isMatched
          ? 'border-petal-edge bg-rose-light/15'
          : shown
            ? 'border-petal-edge bg-rose-light/10'
            : 'border-petal-line bg-black/30 hover:border-petal-edge'
      }`}
    >
      <img
        src={shown ? `${assetBase}/${card.asset}` : `${assetBase}/cookie-card.svg`}
        alt=""
        draggable={false}
        className={`size-[46px] object-contain transition-opacity sm:size-[54px] ${
          card.isMatched ? 'opacity-90' : 'opacity-100'
        }`}
      />
    </button>
  )
}

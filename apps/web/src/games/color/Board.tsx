import { useCallback, useEffect, useRef, useState } from 'react'

import { accuracyPercentage, accuracyScore, hsvToHex, type HsvColor } from './game/color.ts'
import { chooseRounds, roundsPerGame, type ColorRound } from './game/rounds.ts'
import { beatMs, countdownBeats, memoriseMs } from './game/timing.ts'
import './color.css'

type Phase = 'counting' | 'memorising' | 'matching' | 'feedback' | 'over'

const startingGuess: HsvColor = { hue: 330, saturation: 65, value: 80 }

/** A slider the colour is mixed with, drawn as its own gradient. */
function ChannelSlider({
  label,
  value,
  max,
  gradient,
  onChange,
}: {
  label: string
  value: number
  max: number
  gradient: string
  onChange: (next: number) => void
}) {
  return (
    <label className="flex flex-1 flex-col gap-1.5">
      <span className="flex items-baseline justify-between font-ui text-[11px] lowercase text-fg/55">
        {label}
        <span className="tabular-nums text-fg/80">{Math.round(value)}</span>
      </span>
      <input
        type="range"
        min={0}
        max={max}
        value={Math.round(value)}
        onChange={(event) => onChange(Number(event.target.value))}
        aria-label={label}
        className="color-slider h-3 w-full cursor-pointer appearance-none rounded-full border border-petal-line"
        style={{ background: gradient }}
      />
    </label>
  )
}

/**
 * Colour Match: a colour is shown, taken away, and mixed back from memory.
 *
 * Five rounds, each scored on how close the mix looks rather than on how close
 * its numbers are — see `game/color.ts`. The round's score is the mean of the
 * five, so it reads as an accuracy however the game went.
 *
 * Ported from the standalone game, which carried its own lobby, header and
 * background, and drew its targets from other companies' logos. The screen
 * around it supplies the first three; the targets are the event's own colours.
 */
export default function Board({
  onRoundStart,
  onRoundEnd,
}: {
  onRoundStart?: () => void
  onRoundEnd?: (score: number) => void
}) {
  const [rounds, setRounds] = useState<ColorRound[]>(() => chooseRounds())
  const [index, setIndex] = useState(0)
  const [phase, setPhase] = useState<Phase>('counting')
  const [beat, setBeat] = useState(0)
  const [guess, setGuess] = useState<HsvColor>(startingGuess)
  const [accuracies, setAccuracies] = useState<number[]>([])
  const [lastAccuracy, setLastAccuracy] = useState<number | null>(null)

  const opened = useRef(false)
  const reported = useRef(false)

  const round = rounds[index]
  const targetHex = round ? hsvToHex(round.target) : '#000000'
  const guessHex = hsvToHex(guess)

  // "ready · set · go", then the colour appears.
  useEffect(() => {
    if (phase !== 'counting') return
    const timer = window.setTimeout(() => {
      if (beat < countdownBeats.length - 1) setBeat((current) => current + 1)
      else setPhase('memorising')
    }, beatMs)
    return () => window.clearTimeout(timer)
  }, [phase, beat])

  // The colour is held, then taken away. A timeout rather than a frame loop:
  // the bar below is a CSS animation, so nothing here has to run per frame.
  useEffect(() => {
    if (phase !== 'memorising') return
    const timer = window.setTimeout(() => setPhase('matching'), memoriseMs)
    return () => window.clearTimeout(timer)
  }, [phase])

  // The game's score is the mean of its rounds, reported once at the end.
  useEffect(() => {
    if (phase !== 'over' || reported.current) return
    reported.current = true
    onRoundEnd?.(accuracyScore(accuracies))
  }, [phase, accuracies, onRoundEnd])

  const submit = useCallback(() => {
    if (!round) return
    // The run opens with the first colour submitted, not when the board is
    // dealt: a game nobody plays is not a round.
    if (!opened.current) {
      opened.current = true
      onRoundStart?.()
    }
    const accuracy = accuracyPercentage(guess, round.target)
    setLastAccuracy(accuracy)
    setAccuracies((current) => [...current, accuracy])
    setPhase('feedback')
  }, [guess, onRoundStart, round])

  const next = useCallback(() => {
    if (index >= rounds.length - 1) {
      setPhase('over')
      return
    }
    setIndex((current) => current + 1)
    setGuess(startingGuess)
    setBeat(0)
    setPhase('counting')
  }, [index, rounds.length])

  const newGame = useCallback(() => {
    setRounds(chooseRounds())
    setIndex(0)
    setGuess(startingGuess)
    setAccuracies([])
    setLastAccuracy(null)
    setBeat(0)
    setPhase('counting')
    opened.current = false
    reported.current = false
  }, [])

  const mean = accuracies.length > 0 ? accuracyScore(accuracies) / 100 : 0

  return (
    <div className="flex w-full max-w-[520px] flex-col items-center gap-4 lowercase">
      {/* Round, and the accuracy so far. */}
      <div className="flex w-full items-center justify-between gap-4">
        <span className="font-ui text-[11px] lowercase text-fg/55">
          round <span className="tabular-nums text-fg/85">{Math.min(index + 1, roundsPerGame)}</span>
          <span className="text-fg/35">/{roundsPerGame}</span>
        </span>
        <span className="font-ui text-[11px] lowercase text-fg/55">
          accuracy{' '}
          <span className="tabular-nums text-fg/85">
            {accuracies.length > 0 ? `${mean.toFixed(1)}%` : '—'}
          </span>
        </span>
      </div>

      <div className="relative grid h-[220px] w-full place-items-center overflow-hidden rounded-petal border-2 border-petal-line bg-black/40">
        {phase === 'counting' ? (
          <p className="font-display text-[34px] lowercase text-rose-light">
            {countdownBeats[beat]}
          </p>
        ) : phase === 'memorising' ? (
          <>
            <div
              className="size-[136px] rounded-petal-sm border-2 border-white/25"
              style={{ backgroundColor: targetHex }}
            />
            <div className="absolute inset-x-0 bottom-0 h-1 bg-white/10">
              <div
                className="color-memorise-bar h-full bg-rose-light"
                style={{ animationDuration: `${memoriseMs}ms` }}
              />
            </div>
          </>
        ) : phase === 'over' ? (
          <div className="text-center">
            <p className="m-0 font-display text-[30px] lowercase text-rose-light">
              {mean.toFixed(1)}%
            </p>
            <p className="mt-1 font-ui text-[12.5px] lowercase text-fg/60">
              mean accuracy over {roundsPerGame} rounds
            </p>
          </div>
        ) : (
          // Matching and feedback both show the mix; feedback puts the target
          // beside it so the miss is visible rather than only numbered.
          <div className="flex items-center gap-3">
            <div className="text-center">
              <div
                className="size-[112px] rounded-petal-sm border-2 border-white/25"
                style={{ backgroundColor: guessHex }}
              />
              <p className="mt-1.5 m-0 font-ui text-[11px] lowercase text-fg/50">yours</p>
            </div>
            {phase === 'feedback' ? (
              <div className="text-center">
                <div
                  className="size-[112px] rounded-petal-sm border-2 border-white/25"
                  style={{ backgroundColor: targetHex }}
                />
                <p className="mt-1.5 m-0 font-ui text-[11px] lowercase text-fg/50">asked for</p>
              </div>
            ) : null}
          </div>
        )}
      </div>

      {phase === 'matching' ? (
        <>
          <div className="flex w-full gap-4">
            <ChannelSlider
              label="hue"
              value={guess.hue}
              max={360}
              gradient="linear-gradient(to right, #f00 0%, #ff0 17%, #0f0 33%, #0ff 50%, #00f 67%, #f0f 83%, #f00 100%)"
              onChange={(hue) => setGuess((current) => ({ ...current, hue }))}
            />
            <ChannelSlider
              label="saturation"
              value={guess.saturation}
              max={100}
              gradient={`linear-gradient(to right, #fff, ${hsvToHex({ ...guess, saturation: 100, value: 100 })})`}
              onChange={(saturation) => setGuess((current) => ({ ...current, saturation }))}
            />
            <ChannelSlider
              label="value"
              value={guess.value}
              max={100}
              gradient={`linear-gradient(to right, #000, ${hsvToHex({ ...guess, value: 100 })})`}
              onChange={(value) => setGuess((current) => ({ ...current, value }))}
            />
          </div>
          <button
            type="button"
            onClick={submit}
            className="rounded-petal-sm border-2 border-petal-edge bg-rose-light/15 px-4 py-1.5 font-ui text-[13px] lowercase text-fg transition-colors hover:bg-rose-light/25"
          >
            submit
          </button>
        </>
      ) : phase === 'feedback' ? (
        <>
          <p className="m-0 font-ui text-[13px] lowercase text-fg/70">
            <span className="tabular-nums text-rose-light">{lastAccuracy?.toFixed(1)}%</span> on{' '}
            {round?.label}
          </p>
          <button
            type="button"
            onClick={next}
            className="rounded-petal-sm border-2 border-petal-edge bg-rose-light/15 px-4 py-1.5 font-ui text-[13px] lowercase text-fg transition-colors hover:bg-rose-light/25"
          >
            {index >= rounds.length - 1 ? 'finish' : 'next round'}
          </button>
        </>
      ) : phase === 'over' ? (
        <button
          type="button"
          onClick={newGame}
          className="rounded-petal-sm border-2 border-petal-edge bg-rose-light/15 px-4 py-1.5 font-ui text-[13px] lowercase text-fg transition-colors hover:bg-rose-light/25"
        >
          play again
        </button>
      ) : (
        <p className="m-0 font-ui text-[12.5px] lowercase text-fg/55">
          {/* Never the colour's name: it is mixed by eye, and naming it would
              be handing over the answer. It is named in the feedback, once the
              guess is already in. */}
          {phase === 'memorising' ? 'hold it in mind, then mix it back' : 'get ready'}
        </p>
      )}
    </div>
  )
}

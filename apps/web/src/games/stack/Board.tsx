import { useCallback, useEffect, useRef, useState } from 'react'
import { gsap } from 'gsap'

import { GameCanvas, type GameCanvasHandle } from './ui/GameCanvas'
import { GameHud } from './ui/GameHud'
import { GameMenu } from './ui/GameMenu'
import { useGameAudio } from './ui/useGameAudio'
import {
  AIM_MOVE_STEP,
  drawShapeFromBag,
  INITIAL_LIVES,
  loseLife,
  POINTS_PER_PIECE,
  rotateQuarterTurn,
} from './game/rules'
import type { GamePhase, QuarterTurn, ShapeType } from './game/types'
import './stack.css'

/**
 * The stacking board: drop pieces onto the platform and keep the tower up.
 *
 * A round is all three lives together, and the score the arcade records is the
 * total across them — the stack resets with each life, so the per-life score on
 * its own would say nothing about how far someone got.
 *
 * The arcade's leaderboard owns the personal best, so the board reports its
 * total and keeps no score of its own.
 */
export default function Board({
  onRoundStart,
  onRoundEnd,
}: {
  onRoundStart?: () => void
  onRoundEnd?: (score: number) => void
}) {
  const audio = useGameAudio()
  const canvasRef = useRef<GameCanvasHandle>(null)
  const petalsRef = useRef<HTMLDivElement>(null)
  const livesRef = useRef(INITIAL_LIVES)
  const shapeBagRef = useRef<ShapeType[]>([])
  const [score, setScore] = useState(0)
  const [lives, setLives] = useState(INITIAL_LIVES)
  const [totalScore, setTotalScore] = useState(0)
  const [phase, setPhase] = useState<GamePhase>('aiming')
  const [menuOpen, setMenuOpen] = useState(false)
  const [started, setStarted] = useState(false)
  const [lostLifeIndex, setLostLifeIndex] = useState<number | null>(null)
  const [ended, setEnded] = useState(false)
  const [rotation, setRotation] = useState<QuarterTurn>(0)
  const [currentShape, setCurrentShape] = useState<ShapeType>('logo')
  const [nextShape, setNextShape] = useState<ShapeType>('petal')
  const [runId, setRunId] = useState(0)
  const [pieceId, setPieceId] = useState(0)

  const drawNextShape = useCallback(() => {
    const draw = drawShapeFromBag(shapeBagRef.current)
    shapeBagRef.current = draw.bag
    return draw.shape
  }, [])

  const rotate = useCallback(() => {
    if (phase !== 'aiming') return
    canvasRef.current?.rotate()
    setRotation((turn) => rotateQuarterTurn(turn))
  }, [phase])

  const drop = useCallback(() => {
    if (phase !== 'aiming') return
    audio.playDrop()
    canvasRef.current?.drop()
    setPhase('falling')
  }, [audio, phase])

  const startNextPiece = useCallback(() => {
    setCurrentShape(nextShape)
    setNextShape(drawNextShape())
    setRotation(0)
    setPieceId((value) => value + 1)
    setPhase('aiming')
  }, [drawNextShape, nextShape])

  const handleLocked = useCallback(() => {
    audio.playLock()
    setTotalScore((total) => total + POINTS_PER_PIECE)
    setScore((value) => value + POINTS_PER_PIECE)
    startNextPiece()
  }, [audio, startNextPiece])

  /** A fresh stack for the next life. The total carries over; the stack does not. */
  const startFreshLife = useCallback(() => {
    setScore(0)
    setPhase('aiming')
    setRotation(0)
    setCurrentShape(drawNextShape())
    setNextShape(drawNextShape())
    setPieceId(0)
    setRunId((value) => value + 1)
  }, [drawNextShape])

  const handlePieceMissed = useCallback(() => {
    audio.playLifeLost()
    const remainingLives = loseLife(livesRef.current)
    livesRef.current = remainingLives
    setLives(remainingLives)
    setLostLifeIndex(remainingLives)
    return true
  }, [audio])

  // The round's score is reported once, on the life that ends it. The ref resets
  // when PLAY AGAIN deals a new board, so each round reports its own total.
  const reported = useRef(false)
  const endGame = useCallback(() => {
    audio.stopMusic()
    setMenuOpen(false)
    setLostLifeIndex(null)
    setEnded(true)
    setPhase('gameOver')
  }, [audio])

  useEffect(() => {
    if (!ended || reported.current) return
    reported.current = true
    onRoundEnd?.(totalScore)
  }, [ended, onRoundEnd, totalScore])

  /** Open the first life, and with it the run the round is reported against. */
  const start = useCallback(() => {
    if (started) return
    reported.current = false
    audio.startMusic()
    setStarted(true)
    onRoundStart?.()
  }, [audio, onRoundStart, started])

  /** Deal a fresh board and put the play overlay back up, as Pac-Man's does. */
  const restart = useCallback(() => {
    audio.stopMusic()
    livesRef.current = INITIAL_LIVES
    shapeBagRef.current = []
    reported.current = false
    setLives(INITIAL_LIVES)
    setScore(0)
    setTotalScore(0)
    setEnded(false)
    setMenuOpen(false)
    setLostLifeIndex(null)
    setStarted(false)
    setRotation(0)
    setCurrentShape('logo')
    setNextShape('petal')
    setPieceId(0)
    setPhase('aiming')
    setRunId((value) => value + 1)
  }, [audio])

  useEffect(() => {
    if (lostLifeIndex === null) return
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    const timer = window.setTimeout(
      () => {
        setLostLifeIndex(null)
        if (livesRef.current > 0) startFreshLife()
        else endGame()
      },
      reducedMotion ? 80 : 650,
    )
    return () => window.clearTimeout(timer)
  }, [endGame, lostLifeIndex, startFreshLife])

  useEffect(() => {
    const petals = petalsRef.current?.querySelectorAll('i')
    if (!petals || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    const context = gsap.context(() => {
      gsap.set(petals, { y: -40, x: 0, opacity: 0, rotation: 0 })
      petals.forEach((petal, index) => {
        gsap.to(petal, {
          y: '105vh',
          x: 'random(-42, 42)',
          rotation: 'random(-180, 180)',
          opacity: 'random(.12, .32)',
          duration: 'random(10, 16)',
          delay: index * 0.7,
          repeat: -1,
          ease: 'none',
        })
      })
    }, petalsRef)
    return () => context.revert()
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLElement && event.target.tagName === 'INPUT') return
      const key = event.key.toLowerCase()
      if (key === 'p' && !ended && started && lostLifeIndex === null) {
        event.preventDefault()
        setMenuOpen((open) => !open)
        return
      }
      if (!started || menuOpen || ended || lostLifeIndex !== null) return
      if (phase !== 'aiming') return
      if (key === 'arrowleft' || key === 'arrowright' || key === 'a' || key === 'd') {
        event.preventDefault()
        canvasRef.current?.moveBy(
          key === 'arrowleft' || key === 'a' ? -AIM_MOVE_STEP : AIM_MOVE_STEP,
        )
      } else if (event.key === ' ') {
        event.preventDefault()
        rotate()
      } else if (event.key === 'Enter') {
        event.preventDefault()
        drop()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [drop, ended, lostLifeIndex, menuOpen, phase, rotate, started])

  return (
    <div className="stack-game">
      <div ref={petalsRef} className="ambient-petals" aria-hidden="true">
        {Array.from({ length: 12 }, (_, index) => (
          <i key={index} style={{ left: `${8 + ((index * 37) % 84)}%` }} />
        ))}
      </div>
      <section className="game-layout">
        <button
          type="button"
          className="icon-button game-menu-button"
          aria-label="Open menu"
          onClick={() => setMenuOpen(true)}
        >
          ☰
        </button>
        <div className="game-stage">
          <div className="game-board-wrap">
            <div className="canvas-frame">
              <GameCanvas
                ref={canvasRef}
                currentShape={currentShape}
                rotation={rotation}
                runId={runId}
                pieceId={pieceId}
                paused={!started || menuOpen || ended || lostLifeIndex !== null}
                onLocked={handleLocked}
                onPieceMissed={handlePieceMissed}
                onGameOver={endGame}
                onPhaseChange={setPhase}
              />
              <GameHud
                score={score}
                totalScore={totalScore}
                lives={lives}
                lostLifeIndex={lostLifeIndex}
              />
              <button
                type="button"
                className="action-button mobile-drop-button"
                onClick={drop}
                disabled={phase !== 'aiming' || !started || menuOpen || lostLifeIndex !== null}
              >
                Drop
              </button>
            </div>
          </div>
        </div>
      </section>

      {!started && !ended && (
        <div className="overlay-backdrop intro-overlay">
          <button type="button" className="play-button" aria-label="Play" onClick={start}>
            <span className="play-triangle" aria-hidden="true" />
          </button>
        </div>
      )}
      {menuOpen && <GameMenu onClose={() => setMenuOpen(false)} showContinue={false} />}
      {ended && (
        <div className="overlay-backdrop">
          <section
            className="game-over-card wood-board"
            role="dialog"
            aria-modal="true"
            aria-label="Game ended"
          >
            <h1 className="pixel-game-over pixel-font etched-wood-text" aria-label="Game Over">
              <span className="game-over-wordmark-line">Game</span>
              <span className="game-over-wordmark-line game-over-wordmark-line--lower">Over</span>
            </h1>
            <p className="final-score etched-wood-text" aria-live="polite">
              Total score: {totalScore}
            </p>
            <button
              type="button"
              className="action-button action-button--primary"
              onClick={restart}
            >
              PLAY AGAIN
            </button>
          </section>
        </div>
      )}
    </div>
  )
}

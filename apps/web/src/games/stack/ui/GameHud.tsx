import { INITIAL_LIVES } from "../game/rules";
import type { CSSProperties } from "react";

const PETAL_BURST = [
  [54, -8, 8, 5, 630, 0, 44], [42, 25, 5, 3, 710, 28, 116],
  [25, 47, 9, 5, 640, 10, 171], [2, 56, 6, 4, 690, 42, 224],
  [-30, 44, 10, 6, 670, 0, 284], [-51, 23, 5, 4, 735, 34, 340],
  [-57, -6, 8, 4, 610, 18, 402], [-42, -35, 6, 3, 700, 3, 465],
  [-18, -52, 9, 6, 650, 38, 521], [11, -55, 5, 3, 725, 12, 576],
  [38, -43, 8, 5, 680, 27, 636], [53, -24, 6, 4, 620, 6, 698],
  [61, 8, 7, 4, 750, 44, 758], [21, 60, 5, 3, 655, 20, 818],
  [-14, 58, 8, 5, 715, 48, 874], [-55, 2, 6, 4, 645, 15, 932]
] as const;

function petalStyle([x, y, width, height, duration, delay, spin]: typeof PETAL_BURST[number]): CSSProperties {
  return {
    "--poof-x": `${x}px`, "--poof-y": `${y}px`, "--petal-w": `${width}px`, "--petal-h": `${height}px`,
    "--petal-duration": `${duration}ms`, "--petal-delay": `${delay}ms`, "--petal-spin": `${spin}deg`
  } as CSSProperties;
}

interface GameHudProps {
  score: number;
  totalScore: number;
  lives: number;
  lostLifeIndex?: number | null;
}

export function GameHud({ score, totalScore, lives, lostLifeIndex = null }: GameHudProps) {
  return (
    <aside className="game-status" aria-label="Game status">
      <div className="status-panel">
        <span className="hud-label">Current score</span>
        <output aria-label="Current score" className="score-value" aria-live="polite">{score}</output>
      </div>

      <div className="status-panel status-panel--best">
        <span className="hud-label">Total score</span>
        <output aria-label="Total score" className="best-score-value">{totalScore}</output>
      </div>

      <div className="status-panel status-panel--lives">
        <span className="hud-label">Lives</span>
        <output aria-label="Lives remaining" className="life-pips" aria-live="polite">
          <span className="visually-hidden">{lives}</span>
          {Array.from({ length: INITIAL_LIVES }, (_, index) => (
            <span
              key={index}
              aria-hidden="true"
              className={index < lives ? "life-pip is-active" : index === lostLifeIndex ? "life-pip is-poofing" : "life-pip"}
            >
              {index === lostLifeIndex && <span className="life-petal-poof">{PETAL_BURST.map((petal, petalIndex) => <i key={petalIndex} style={petalStyle(petal)} />)}</span>}
            </span>
          ))}
        </output>
      </div>
    </aside>
  );
}

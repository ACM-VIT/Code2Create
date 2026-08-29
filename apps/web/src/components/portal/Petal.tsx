const PETAL_PATH = 'M12 2c5 4 5.5 10 .5 14.5l-.5.5-.5-.5C6.5 12 7 6 12 2z'

type PetalState = 'done' | 'current' | 'todo'

/** The sakura petal glyph — the portal's progress and accent mark. */
export function Petal({ size = 14, state = 'done' }: { size?: number; state?: PetalState }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      {state === 'todo' ? (
        <path d={PETAL_PATH} fill="none" stroke="rgb(216 132 162 / .6)" strokeWidth="1.6" />
      ) : (
        <path d={PETAL_PATH} fill={state === 'current' ? '#d884a2' : '#feb4cb'}>
          {state === 'current' ? (
            <animate attributeName="opacity" values="1;.45;1" dur="2.2s" repeatCount="indefinite" />
          ) : null}
        </path>
      )}
    </svg>
  )
}

/**
 * The step indicator: one petal per step, filled behind you, pulsing where you
 * are, outlined ahead. It replaces a numeric "step 1 of 3" counter, so the
 * count still ships to assistive tech via the label.
 */
export function SakuraSteps({ total, current }: { total: number; current: number }) {
  return (
    <div
      className="flex gap-2.5"
      role="img"
      aria-label={`Step ${Math.min(current + 1, total)} of ${total}`}
    >
      {Array.from({ length: total }, (_, index) => (
        <Petal
          key={index}
          state={index < current ? 'done' : index === current ? 'current' : 'todo'}
        />
      ))}
    </div>
  )
}

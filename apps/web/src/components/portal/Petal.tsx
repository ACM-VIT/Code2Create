const PETAL_PATH = "M12 2c5 4 5.5 10 .5 14.5l-.5.5-.5-.5C6.5 12 7 6 12 2z";

type PetalState = "done" | "current" | "todo";

export function Petal({ size = 14, state = "done" }: { size?: number; state?: PetalState }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      {state === "todo" ? (
        <path
          d={PETAL_PATH}
          fill="none"
          stroke="var(--color-rose)"
          strokeOpacity=".6"
          strokeWidth="1.6"
        />
      ) : (
        <path
          d={PETAL_PATH}
          fill={state === "current" ? "var(--color-petal-b)" : "var(--color-petal-a)"}
        >
          {state === "current" ? (
            <animate attributeName="opacity" values="1;.45;1" dur="2.2s" repeatCount="indefinite" />
          ) : null}
        </path>
      )}
    </svg>
  );
}

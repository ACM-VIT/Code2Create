import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { PETAL_RADIUS } from "./Petals";

const BLOOM_MS = 4200;
const BURST_AT_MS = 2300;
const HOLD_MS = 4700;
const FADE_MS = 700;

type Burst = {
  id: number;
  size: number;
  x: string;
  y: string;
  r: string;
  delay: number;
  duration: number;
  color: string;
};

function makeBurst(): Burst[] {
  return Array.from({ length: 26 }, (_, id) => {
    const angle = (id / 26) * Math.PI * 2 + Math.random() * 0.5;
    const distance = 16 + Math.random() * 30;
    return {
      id,
      size: 7 + Math.round(Math.random() * 7),
      x: `${Math.cos(angle) * distance}vmin`,
      // a touch of lift, then the fall is baked into the drift target
      y: `${Math.sin(angle) * distance * 0.7 + 12 + Math.random() * 10}vmin`,
      r: `${180 + Math.round(Math.random() * 420)}deg`,
      delay: Math.random() * 260,
      duration: 1500 + Math.random() * 900,
      color: id % 2 ? "var(--color-petal-a)" : "var(--color-petal-b)",
    };
  });
}

/**
 * The moment after Submit: a full-screen interstitial where Yash's
 * generative branch flowers open over ~4 seconds, a handful of petals
 * burst as the blooms complete, and the whole thing fades into the
 * Submitted screen. Click, Escape, or reduced motion skips straight
 * through; three.js loads only for this moment.
 */
export function SubmitCelebration({ onDone }: { onDone: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [fading, setFading] = useState(false);
  const [burst, setBurst] = useState(false);
  const [petals] = useState(makeBurst);
  const onDoneRef = useRef(onDone);
  const finishRef = useRef<() => void>(() => {});

  useEffect(() => {
    onDoneRef.current = onDone;
  }, [onDone]);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      onDoneRef.current();
      return;
    }
    let cancelled = false;
    let finished = false;
    let scene: { play(ms?: number): void; dispose(): void } | null = null;
    const timers = new Set<number>();
    const later = (fn: () => void, ms: number) => {
      const timer = window.setTimeout(fn, ms);
      timers.add(timer);
    };

    const finish = () => {
      if (finished) return;
      finished = true;
      // Hand off through a view transition where available: the overlay
      // crossfades away while the closing "submitted." morphs up into the
      // Submitted screen's heading. Elsewhere, a plain fade.
      const transition = (
        document as Document & { startViewTransition?: (update: () => void) => unknown }
      ).startViewTransition;
      if (transition) {
        transition.call(document, () => flushSync(() => onDoneRef.current()));
      } else {
        setFading(true);
        later(() => onDoneRef.current(), FADE_MS);
      }
    };
    finishRef.current = finish;

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") finish();
    };
    window.addEventListener("keydown", onKey);

    void import("./flowerScene")
      .then(({ createFlowerScene }) => {
        if (cancelled) return;
        const canvas = canvasRef.current;
        if (!canvas) return finish();
        try {
          scene = createFlowerScene(canvas);
          scene.play(BLOOM_MS);
        } catch {
          return finish();
        }
        later(() => setBurst(true), BURST_AT_MS);
        later(finish, HOLD_MS);
      })
      .catch(finish);

    return () => {
      cancelled = true;
      window.removeEventListener("keydown", onKey);
      for (const timer of timers) window.clearTimeout(timer);
      scene?.dispose();
    };
  }, []);

  return (
    <div
      role="dialog"
      aria-label="Proposal submitted"
      onClick={() => finishRef.current()}
      className={`fixed inset-0 z-[9] bg-ink transition-opacity ease-out ${
        fading ? "opacity-0" : "opacity-100"
      }`}
      style={{ transitionDuration: `${FADE_MS}ms` }}
    >
      <canvas ref={canvasRef} className="block h-full w-full" />

      {/* The demo's stage vignette, so the branch melts into the dark. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(76%_44%_at_50%_82%,rgb(0_0_0/.88),transparent_72%),linear-gradient(to_top,rgb(0_0_0/.9)_0%,rgb(0_0_0/.34)_34%,transparent_62%),radial-gradient(140%_100%_at_50%_34%,transparent_40%,rgb(0_0_0/.62)_100%)]"
      />

      {burst ? (
        <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
          {petals.map((petal) => (
            <span
              key={petal.id}
              className="absolute top-[46%] left-1/2 block"
              style={{
                width: `${petal.size}px`,
                height: `${petal.size}px`,
                background: petal.color,
                borderRadius: PETAL_RADIUS,
                animation: `c2cburst ${petal.duration}ms cubic-bezier(.16,.65,.35,1) ${petal.delay}ms both`,
                ["--burst-x" as string]: petal.x,
                ["--burst-y" as string]: petal.y,
                ["--burst-r" as string]: petal.r,
              }}
            />
          ))}
        </div>
      ) : null}

      <p
        className={`pointer-events-none absolute inset-x-0 bottom-[14%] text-center font-display font-light tracking-[-.01em] text-4xl text-paper transition-opacity duration-1000 [view-transition-name:submitted-heading] lg:text-5xl ${
          burst ? "opacity-100" : "opacity-0"
        }`}
      >
        submitted.
      </p>

      <button
        type="button"
        onClick={() => finishRef.current()}
        className="absolute right-6 bottom-6 text-[12.5px] text-paper/50 transition-colors hover:text-rose-light"
      >
        skip
      </button>
    </div>
  );
}

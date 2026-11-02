import { useEffect, useRef, useState } from "react";
import { togglePortalTheme, usePortalTheme } from "../../lib/portalTheme";

export function DaybreakToggle() {
  const theme = usePortalTheme();
  const daybreak = theme === "daybreak";
  const parity = useRef(daybreak ? 0 : 1);
  const turns = useRef(0);
  const [angle, setAngle] = useState(() => (daybreak ? 0 : 180));
  const seenTheme = useRef(theme);
  useEffect(() => {
    if (seenTheme.current === theme) return;
    seenTheme.current = theme;
    turns.current += 1;
    // The orbit answers a theme change from anywhere (the other toggle, storage); it is painted at its old angle, so the transition needs no deferred frame.
    setAngle((parity.current + turns.current) * 180);
  }, [theme]);

  const easing =
    "duration-700 [transition-timing-function:cubic-bezier(.5,.05,.2,1)] motion-reduce:transition-none";

  return (
    <button
      type="button"
      onClick={togglePortalTheme}
      aria-label={daybreak ? "Switch to night" : "Switch to daybreak"}
      title={daybreak ? "Switch to night" : "Switch to daybreak"}
      className="relative size-10 flex-none overflow-hidden rounded-full border-2 border-rose/70 bg-avatar transition-colors duration-250 [view-transition-name:daybreak-toggle] hover:border-rose-light lg:size-12"
    >
      <span
        aria-hidden
        className={`absolute inset-0 block transition-transform will-change-transform ${easing}`}
        style={{ transform: `rotate(${angle}deg)` }}
      >
        <span
          className={`absolute top-[12%] left-1/2 block w-[36%] text-[#e8913d] transition-[transform,opacity] ${easing} ${
            daybreak ? "opacity-100" : "opacity-40"
          }`}
          style={{ transform: `translateX(-50%) rotate(${-angle}deg)` }}
        >
          <svg viewBox="0 0 24 24" className="block w-full">
            <circle cx="12" cy="12" r="5" fill="currentColor" />
            <g stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <path d="M12 1.5v3M12 19.5v3M1.5 12h3M19.5 12h3M4.6 4.6l2.1 2.1M17.3 17.3l2.1 2.1M4.6 19.4l2.1-2.1M17.3 6.7l2.1-2.1" />
            </g>
          </svg>
        </span>
        <span
          className={`absolute bottom-[12%] left-1/2 block w-[34%] text-rose-light transition-[transform,opacity] ${easing} ${
            daybreak ? "opacity-40" : "opacity-100"
          }`}
          style={{ transform: `translateX(-50%) rotate(${-angle}deg)` }}
        >
          <svg viewBox="0 0 24 24" className="block w-full">
            <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5z" fill="currentColor" />
          </svg>
        </span>
      </span>

      {/* The ground: a translucent hemisphere the set body glows through. */}
      <span aria-hidden className="absolute inset-x-0 top-1/2 bottom-0 bg-rose/20" />
      <span aria-hidden className="absolute inset-x-[10%] top-1/2 h-px bg-rose/45" />
    </button>
  );
}

import {
  useEffect,
  useRef,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type UIEvent,
} from "react";

import { slotAreaClass, type Slot } from "./dashboardLayout";

/**
 * One glass tile on the bento. Tiles with `onToggle` respond when the card is
 * activated anywhere outside a nested control. `expanded` is the one case
 * where the card has taken the big slot and a corner control releases it.
 */
export function Tile({
  slot,
  open = false,
  expanded = false,
  onToggle,
  onRelease,
  backdrop,
  className = "",
  children,
}: {
  slot: Slot;
  open?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
  onRelease?: () => void;
  backdrop?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const scrollingTimer = useRef<number | null>(null);
  useEffect(() => () => {
    if (scrollingTimer.current !== null) window.clearTimeout(scrollingTimer.current);
  }, []);
  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    const container = event.currentTarget;
    container.dataset.scrolling = "true";
    if (scrollingTimer.current !== null) window.clearTimeout(scrollingTimer.current);
    scrollingTimer.current = window.setTimeout(() => {
      delete container.dataset.scrolling;
      scrollingTimer.current = null;
    }, 650);
  };

  const tappable = !expanded && onToggle !== undefined;
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!tappable || event.target !== event.currentTarget) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onToggle?.();
  };
  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    if (!tappable) return;
    if (
      event.target instanceof Element &&
      event.target.closest("button, a, input, textarea, select, label")
    ) {
      return;
    }
    onToggle?.();
  };
  const lit = open || expanded;
  return (
    <div
      className={`relative z-10 flex min-h-0 min-w-0 flex-col overflow-hidden rounded-[18px] border bg-fg/5 shadow-[0_20px_44px_-30px_var(--shade-2),inset_0_1px_0_color-mix(in_srgb,var(--color-fg)_14%,transparent)] backdrop-blur-[22px] backdrop-saturate-[1.35] transition-[border-color,background-color,transform] duration-300 ${
        lit ? "border-rose-light/60 bg-fg/7" : "border-petal-edge/70"
      } ${
        tappable
          ? "cursor-pointer hover:border-rose-light/70 hover:bg-fg/8 focus-visible:border-rose-light focus-visible:outline-none active:scale-[.995]"
          : ""
      } ${slotAreaClass[slot]} ${className}`}
      style={{ viewTransitionName: `dash-${slot}` }}
      {...(tappable
        ? { role: "button", tabIndex: 0, onClick, onKeyDown, "aria-expanded": lit }
        : expanded
          ? { "aria-expanded": true }
          : {})}
    >
      {backdrop}
      <div
        onScroll={onScroll}
        className="dashboard-tile-scroll relative flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto [container-type:size]"
      >
        {children}
      </div>
      {expanded && onRelease ? (
        <button
          type="button"
          onClick={onRelease}
          aria-label="Close"
          className="absolute top-3 right-3 z-20 flex size-8 items-center justify-center rounded-full border border-rose/50 bg-wash/60 text-fg/80 backdrop-blur-md transition-colors hover:border-rose-light hover:text-fg"
        >
          <svg viewBox="0 0 16 16" className="size-3.5" aria-hidden>
            <path
              d="M3 3l10 10M13 3L3 13"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
          </svg>
        </button>
      ) : null}
    </div>
  );
}

/** The small caps label every tile opens with. */
export function TileEyebrow({ children }: { children: ReactNode }) {
  return <p className="m-0 font-ui text-[15px] text-rose-light">{children}</p>;
}

/** Content that arrives in place: a short rise and fade, honoured by reduced motion. */
export function Reveal({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`translate-y-0 opacity-100 motion-safe:transition-[transform,opacity] motion-safe:duration-[420ms] motion-safe:ease-[cubic-bezier(.22,1,.36,1)] starting:translate-y-2 starting:opacity-0 ${className}`}
    >
      {children}
    </div>
  );
}

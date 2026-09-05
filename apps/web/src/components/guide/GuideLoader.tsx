import { LiveElapsed } from "../LiveNumber";
import type { ReactNode } from "react";
import { useElapsed } from "./guideTime";

const cycleMs = 650;

const chevron = Array.from({ length: 9 }, (_, index) => {
  const row = Math.floor(index / 3);
  const column = index % 3;
  return (column + Math.abs(row - 1)) * 90;
});

export function PixelLoader({ round = false }: { round?: boolean }) {
  return (
    <span aria-hidden className="grid shrink-0 grid-cols-[repeat(3,4px)] gap-[1.5px]">
      {chevron.map((delay, index) => (
        <span
          key={index}
          className={`block size-[4px] bg-rose-light opacity-15 motion-safe:animate-pixel ${round ? "rounded-full" : "rounded-[1px]"}`}
          style={{ animationDelay: `${delay}ms`, animationDuration: `${cycleMs}ms` }}
        />
      ))}
    </span>
  );
}

/** A label with a light sweep through the glyphs, on gradient-clipped text. */
export function ShimmerLabel({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`bg-clip-text text-transparent motion-safe:animate-shimmer-label motion-reduce:text-fg/70 ${className}`}
      style={{
        backgroundImage:
          "linear-gradient(90deg, color-mix(in oklab, var(--color-fg) 45%, transparent) 35%, var(--color-fg) 50%, color-mix(in oklab, var(--color-fg) 45%, transparent) 65%)",
        backgroundSize: "200% 100%",
      }}
    >
      {children}
    </span>
  );
}

/** Loader, shimmering label, and the ticking timer, on one line. */
export function LoadingLine({
  label,
  startedAt,
  className = "",
}: {
  label: string;
  startedAt?: number | undefined;
  className?: string;
}) {
  const elapsed = useElapsed(startedAt);
  return (
    <span role="status" className={`inline-flex w-fit items-center gap-2.5 ${className}`}>
      <PixelLoader />
      <ShimmerLabel className="text-[13px] font-medium">{label}</ShimmerLabel>
      <span className="font-mono text-[12px] text-fg/45 tabular-nums"><LiveElapsed milliseconds={elapsed} /></span>
    </span>
  );
}

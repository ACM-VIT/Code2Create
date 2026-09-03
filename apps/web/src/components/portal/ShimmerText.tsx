/**
 * A line of waiting-state text with a light sweep passing through the glyphs.
 * The base span is the real text; the inert clone above it carries the sweep,
 * masked to its own glyphs (see .shimmer-text in index.css for why a clone).
 */
export function ShimmerText({
  children,
  className = "",
}: {
  children: string;
  className?: string;
}) {
  return (
    <span className={`shimmer-text ${className}`}>
      <span>{children}</span>
      <span inert aria-hidden className="shimmer-text-clone">
        {children}
      </span>
    </span>
  );
}

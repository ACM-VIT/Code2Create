/**
 * Loading shells.
 *
 * Every screen used to render the word "Loading…" on an empty page, so the
 * layout jumped once data arrived and there was no sense of what was coming.
 * These stand in for the real shape at the real size, which keeps the page
 * still and tells you what to expect.
 */

export function SkeletonLine({ width = '100%' }: { width?: string }) {
  return <span className="skeleton-line" style={{ width }} />
}

/** A stand-in for one row of a list: glyph, two lines, trailing control. */
export function SkeletonRow() {
  return (
    <div className="list-row skeleton-row">
      <span className="row-glyph skeleton-block" />
      <div className="row-text">
        <SkeletonLine width="38%" />
        <SkeletonLine width="72%" />
      </div>
      <span className="skeleton-block skeleton-action" />
    </div>
  )
}

export function SkeletonList({ rows = 4 }: { rows?: number }) {
  return (
    <div className="health-list" aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => <SkeletonRow key={index} />)}
    </div>
  )
}

/** A stand-in for a stat strip, so the numbers do not shift in when they land. */
export function SkeletonStats({ columns = 4 }: { columns?: number }) {
  return (
    <div className="catalog-summary" aria-hidden="true">
      {Array.from({ length: columns }, (_, index) => (
        <div key={index}>
          <SkeletonLine width="52%" />
          <SkeletonLine width="34%" />
        </div>
      ))}
    </div>
  )
}

export function SkeletonCard({ lines = 3 }: { lines?: number }) {
  return (
    <div className="skeleton-card" aria-hidden="true">
      {Array.from({ length: lines }, (_, index) => (
        <SkeletonLine key={index} width={index === lines - 1 ? '58%' : '100%'} />
      ))}
    </div>
  )
}

/**
 * Announces to a screen reader what the shells above are standing in for,
 * since they are hidden from the accessibility tree.
 */
export function LoadingLabel({ children }: { children: string }) {
  return <span className="visually-hidden" role="status">{children}</span>
}

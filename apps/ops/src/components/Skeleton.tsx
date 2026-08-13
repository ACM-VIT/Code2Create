
export function SkeletonLine({ width = '100%' }: { width?: string }) {
  return <span className="skeleton-line" style={{ width }} />
}

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

export function LoadingLabel({ children }: { children: string }) {
  return <span className="visually-hidden" role="status">{children}</span>
}

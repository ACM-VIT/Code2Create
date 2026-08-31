import { useEffect, useState } from 'react'

const revealDelay = 300

export function DelayedBonsai({ compact = false }: { compact?: boolean }) {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const timer = window.setTimeout(() => setVisible(true), revealDelay)
    return () => window.clearTimeout(timer)
  }, [])

  if (!visible) return null

  return (
    <div className={`delayed-bonsai${compact ? ' delayed-bonsai-compact' : ''}`} role="status">
      <div className="delayed-bonsai-art" aria-hidden="true">
        <img src="/plants/plant-01.svg" alt="" />
        {Array.from({ length: 9 }, (_, index) => <i key={index} />)}
      </div>
      <span className="delayed-bonsai-label">just a moment</span>
    </div>
  )
}

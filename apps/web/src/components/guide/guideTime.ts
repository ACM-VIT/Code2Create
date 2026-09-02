import { useEffect, useState } from 'react'

/** Time since `startedAt` (or since mount), read every tenth of a second. */
export function useElapsed(startedAt?: number) {
  const [now, setNow] = useState(() => Date.now())
  const [mountedAt] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 100)
    return () => window.clearInterval(timer)
  }, [])
  return Math.max(0, now - (startedAt ?? mountedAt))
}

/** A duration the way the loaders print it: tenths of a second, minutes past sixty. */
export function elapsedName(milliseconds: number) {
  const total = milliseconds / 1000
  if (total < 60) return `${total.toFixed(1)}s`
  return `${Math.floor(total / 60)}m ${(total % 60).toFixed(1)}s`
}

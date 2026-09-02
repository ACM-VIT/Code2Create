import { useEffect, useState } from 'react'

export function useClock(tickMs = 60_000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), tickMs)
    return () => window.clearInterval(timer)
  }, [tickMs])
  return now
}

import { useEffect, useState } from 'react'

function useElapsed() {
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setSeconds((current) => current + 1), 1_000)
    return () => clearInterval(timer)
  }, [])
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

export function LoadingState({
  label = 'Working',
}: {
  label?: string
}) {
  const elapsed = useElapsed()

  return (
    <div className="flex w-fit items-baseline gap-2.5" role="status">
      <StatusText>{label}</StatusText>
      <span className="font-mono text-[12px] text-ink-3 tabular-nums">
        {elapsed}
      </span>
    </div>
  )
}

export function StatusText({ children }: { children: string }) {
  return (
    <span className="text-[13px] font-medium whitespace-nowrap text-ink-2">
      {children}
    </span>
  )
}

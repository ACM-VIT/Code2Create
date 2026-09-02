export function countdownName(seconds: number) {
  if (seconds >= 90) {
    const minutes = Math.ceil(seconds / 60)
    return `${minutes} minutes`
  }
  return `${seconds} second${seconds === 1 ? '' : 's'}`
}

export const maximumBrowserTimerDelay = 2_147_000_000

export function nextDeadlineTimerDelay(
  deadline: number,
  currentTime: number,
  graceMs = 100,
) {
  const remaining = deadline - currentTime
  if (remaining <= 0) return null
  return Math.min(remaining + graceMs, maximumBrowserTimerDelay)
}

export function scheduleDeadline(
  deadline: number,
  currentTime: () => number,
  onReached: () => void,
  graceMs = 100,
) {
  let timer: number | null = null
  const checkDeadline = () => {
    const delay = nextDeadlineTimerDelay(deadline, currentTime(), graceMs)
    if (delay === null) {
      onReached()
      return
    }
    timer = window.setTimeout(checkDeadline, delay)
  }
  checkDeadline()
  return () => {
    if (timer !== null) window.clearTimeout(timer)
  }
}

export function queueWaitName(
  estimate: { earliestAt: number; latestAt: number },
  now: number,
) {
  if (estimate.latestAt <= now) return 'Taking longer than estimated'
  const upperMinutes = Math.max(5, Math.ceil((estimate.latestAt - now) / 300_000) * 5)
  if (estimate.earliestAt <= now) return `Within ${upperMinutes} min`
  const lowerMinutes = Math.max(0, Math.floor((estimate.earliestAt - now) / 300_000) * 5)
  return lowerMinutes === 0
    ? `Within ${upperMinutes} min`
    : `About ${lowerMinutes}–${upperMinutes} min`
}

/** How long ago something happened, in the coarse words a participant reads at a glance. */
export function elapsedName(value: number, now: number) {
  const minutes = Math.max(0, Math.round((now - value) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`
  const days = Math.round(hours / 24)
  return `${days} ${days === 1 ? 'day' : 'days'} ago`
}

export function countdownName(seconds: number) {
  if (seconds >= 90) {
    const minutes = Math.ceil(seconds / 60)
    return `${minutes} minutes`
  }
  return `${seconds} second${seconds === 1 ? '' : 's'}`
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

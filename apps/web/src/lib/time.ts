export function countdownName(seconds: number) {
  if (seconds >= 90) {
    const minutes = Math.ceil(seconds / 60)
    return `${minutes} minutes`
  }
  return `${seconds} second${seconds === 1 ? '' : 's'}`
}

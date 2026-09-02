export function releaseBalloons() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
  void import('balloons-js')
    .then(({ balloons }) => balloons())
    .catch(() => undefined)
}

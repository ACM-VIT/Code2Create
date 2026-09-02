import { useSyncExternalStore } from 'react'

const desktopQuery = '(min-width: 640px)'

function subscribeDesktop(onChange: () => void) {
  const media = window.matchMedia(desktopQuery)
  media.addEventListener('change', onChange)
  return () => media.removeEventListener('change', onChange)
}

/** True from the `sm` breakpoint up — where popovers and side sheets fit. */
export function useDesktop() {
  return useSyncExternalStore(subscribeDesktop, () => window.matchMedia(desktopQuery).matches)
}

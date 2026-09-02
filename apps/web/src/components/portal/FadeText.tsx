import { useEffect, useState, type ReactNode } from 'react'

export function FadeText({
  as = 'span',
  className = '',
  children,
}: {
  as?: 'span' | 'p'
  className?: string
  children: ReactNode
}) {
  const [element, setElement] = useState<HTMLElement | null>(null)
  const [overflowing, setOverflowing] = useState(false)

  useEffect(() => {
    if (!element) return
    const measure = () => setOverflowing(element.scrollWidth > element.clientWidth + 1)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    // ResizeObserver reports on the next rendering step; a viewport change
    // (rotation, a resized window) also reaches us through the resize event.
    window.addEventListener('resize', measure)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [element, children])

  const classes = `block overflow-hidden whitespace-nowrap ${
    overflowing ? '[mask-image:linear-gradient(to_right,black_calc(100%-56px),transparent)]' : ''
  } ${className}`

  return as === 'p' ? (
    <p ref={setElement} className={classes}>
      {children}
    </p>
  ) : (
    <span ref={setElement} className={classes}>
      {children}
    </span>
  )
}

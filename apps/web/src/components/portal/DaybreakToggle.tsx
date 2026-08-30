import { togglePortalTheme, usePortalTheme } from '../../lib/portalTheme'

/**
 * The light switch for the scene: one more circle in the header's avatar
 * row — a coin-sized horizon holding the sky instead of a person. At night
 * a blush moon hangs over the line; pressing it sets the moon and raises a
 * gold sun, and the whole portal follows into daybreak. Sized and bordered
 * to match the team-cluster avatars so the row reads as one family.
 */
export function DaybreakToggle() {
  const theme = usePortalTheme()
  const daybreak = theme === 'daybreak'
  const icon =
    'pointer-events-none absolute top-[14%] left-1/2 w-[36%] -translate-x-1/2 transition-[translate,opacity] duration-500 ease-out'
  return (
    <button
      type="button"
      onClick={togglePortalTheme}
      aria-label={daybreak ? 'Switch to night' : 'Switch to daybreak'}
      title={daybreak ? 'Switch to night' : 'Switch to daybreak'}
      className="relative size-10 flex-none overflow-hidden rounded-full border-2 border-rose/70 bg-avatar transition-colors duration-250 hover:border-rose-light lg:size-12"
    >
      {/* The ground below the horizon line. */}
      <span aria-hidden className="absolute inset-x-0 top-1/2 bottom-0 bg-rose/15" />
      <span aria-hidden className="absolute inset-x-[10%] top-1/2 h-px bg-rose/45" />

      {/* The moon: up at night, set below the horizon at daybreak. */}
      <svg
        viewBox="0 0 24 24"
        aria-hidden
        className={`${icon} text-rose-light ${
          daybreak ? 'translate-y-[120%] opacity-0' : 'translate-y-0 opacity-100'
        }`}
      >
        <path
          d="M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5z"
          fill="currentColor"
        />
      </svg>

      {/* The sun: risen at daybreak, waiting below the line at night. */}
      <svg
        viewBox="0 0 24 24"
        aria-hidden
        className={`${icon} text-[#e8913d] ${
          daybreak ? 'translate-y-0 opacity-100' : 'translate-y-[120%] opacity-0'
        }`}
      >
        <circle cx="12" cy="12" r="5" fill="currentColor" />
        <g stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          <path d="M12 1.5v3M12 19.5v3M1.5 12h3M19.5 12h3M4.6 4.6l2.1 2.1M17.3 17.3l2.1 2.1M4.6 19.4l2.1-2.1M17.3 6.7l2.1-2.1" />
        </g>
      </svg>
    </button>
  )
}

import { Link, useLocation } from 'react-router-dom'

type Destination = {
  label: string
  to: string
  icon: 'overview' | 'team' | 'resources'
  active: (pathname: string) => boolean
}

const destinations: readonly Destination[] = [
  {
    label: 'Overview',
    to: '/',
    icon: 'overview',
    active: (pathname) => pathname === '/' || pathname === '/write',
  },
  {
    label: 'Team',
    to: '/team',
    icon: 'team',
    active: (pathname) => pathname === '/team',
  },
  {
    label: 'Resources',
    to: '/more',
    icon: 'resources',
    active: (pathname) =>
      pathname === '/more' ||
      pathname.startsWith('/integrations') ||
      pathname === '/music' ||
      pathname === '/support',
  },
]

function DestinationIcon({ icon }: { icon: Destination['icon'] }) {
  if (icon === 'overview') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
        <path d="M4 10.5 12 4l8 6.5" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M6.5 9.5V20h11V9.5M10 20v-5h4v5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  }
  if (icon === 'team') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
        <circle cx="9" cy="8" r="3" />
        <circle cx="17" cy="9" r="2.25" />
        <path d="M3.5 19c.35-3.35 2.2-5 5.5-5s5.15 1.65 5.5 5M14 14.5c3.6-.7 5.75.8 6.25 3.75" strokeLinecap="round" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <path d="M5 5h5v5H5zM14 5h5v5h-5zM5 14h5v5H5zM14 14h5v5h-5z" strokeLinejoin="round" />
    </svg>
  )
}

function NavigationLink({ destination, mobile = false }: { destination: Destination; mobile?: boolean }) {
  const { pathname } = useLocation()
  const active = destination.active(pathname)

  return (
    <Link
      to={destination.to}
      viewTransition
      aria-current={active ? 'page' : undefined}
      className={mobile
        ? `flex min-w-[72px] flex-1 flex-col items-center justify-center gap-1 rounded-[18px] px-2 py-2 text-[10px] font-medium no-underline transition-colors duration-200 ${
            active ? 'bg-rose/15 text-rose-light' : 'text-fg/55 hover:text-fg'
          }`
        : `rounded-full px-4 py-2.5 text-[12.5px] font-medium no-underline transition-colors duration-200 ${
            active ? 'bg-rose/15 text-rose-light' : 'text-fg/55 hover:bg-fg/5 hover:text-fg'
          }`}
    >
      {mobile ? <span className="size-[19px]"><DestinationIcon icon={destination.icon} /></span> : null}
      <span>{destination.label}</span>
    </Link>
  )
}

/** Persistent product navigation. It stays in the header on wide screens and
 * becomes a thumb-reachable bottom bar on smaller ones. */
export function PortalNavigation({ hasTeam }: { hasTeam: boolean }) {
  const visibleDestinations = hasTeam
    ? destinations
    : destinations.filter((destination) => destination.icon !== 'team')

  return (
    <>
      <nav aria-label="Primary navigation" className="glass-menu hidden items-center rounded-full p-1 lg:flex">
        {visibleDestinations.map((destination) => (
          <NavigationLink key={destination.to} destination={destination} />
        ))}
      </nav>
      <nav
        aria-label="Primary navigation"
        className="glass-menu fixed right-3 bottom-[max(12px,env(safe-area-inset-bottom))] left-3 z-20 mx-auto flex max-w-[380px] items-stretch rounded-[24px] p-1.5 shadow-[0_14px_44px_var(--shade-1)] lg:hidden"
      >
        {visibleDestinations.map((destination) => (
          <NavigationLink key={destination.to} destination={destination} mobile />
        ))}
      </nav>
    </>
  )
}

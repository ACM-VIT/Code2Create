import { initialsOf } from './initials'

/**
 * The onboarding header: the updated mockup shows only the avatar, so the
 * email and verified class ride in the tooltip while sign-out stays visible.
 */
export function AccountBadge({
  name,
  email,
  detail,
  onSignOut,
}: {
  name: string
  email?: string
  detail?: string
  onSignOut?: () => void
}) {
  return (
    <div className="flex items-center gap-2.5">
      <div
        title={[email ?? name, detail].filter(Boolean).join(' · ')}
        className="flex size-[34px] flex-none items-center justify-center rounded-full border-2 border-rose-light bg-avatar-lead text-[11px] font-semibold"
      >
        {initialsOf(name)}
      </div>
      {onSignOut ? (
        <button
          type="button"
          onClick={onSignOut}
          className="ml-1 rounded-sm text-[12px] text-[rgb(248_248_248/.45)] transition-colors hover:text-rose-light"
        >
          Sign out
        </button>
      ) : null}
    </div>
  )
}

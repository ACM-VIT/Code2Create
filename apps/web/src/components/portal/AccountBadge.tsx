import { initialsOf } from './initials'

/**
 * The onboarding header: who Google says you are, and the class the server
 * verified you into. Used before a team exists, where TeamCluster would have
 * nothing to show.
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
      <div className="flex size-[34px] flex-none items-center justify-center rounded-full border-2 border-rose-light bg-avatar-lead text-[11px] font-semibold">
        {initialsOf(name)}
      </div>
      <p className="m-0 hidden min-h-[34px] items-center text-[12.5px] leading-none text-[rgb(248_248_248/.6)] sm:flex">
        {email ?? name}
        {detail ? <span className="text-rose-light"> · {detail}</span> : null}
      </p>
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

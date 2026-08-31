/**
 * Sign-out as the portal draws it everywhere: a dashed circle with an exit
 * door, never a bare word. Pass `className` for stack offsets.
 */
export function SignOutCircle({
  onSignOut,
  className = '',
}: {
  onSignOut: () => void
  className?: string
}) {
  return (
    <button
      type="button"
      title="Sign out"
      aria-label="Sign out"
      onClick={onSignOut}
      className={`flex size-10 flex-none items-center justify-center rounded-full border-2 border-dashed border-rose/45 bg-avatar/60 text-fg/50 transition-all duration-250 hover:border-rose-light hover:text-rose-light lg:size-12 ${className}`}
    >
      <svg
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" />
        <path d="M10 17l5-5-5-5" />
        <path d="M15 12H3" />
      </svg>
    </button>
  )
}

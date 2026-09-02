import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Flower } from './FlowerAvatar'

/**
 * The signed-in person before there is a team to stand with: one flower circle
 * that opens identity, profile, and sign-out actions.
 */
export function AccountBadge({
  name,
  seed,
  email,
  detail,
  onSignOut,
}: {
  name: string
  seed: string
  email?: string
  detail?: string
  onSignOut: () => void
}) {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !anchor.current?.contains(event.target)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div ref={anchor} className="relative">
      <button
        type="button"
        aria-label={`Account, ${name}`}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={`flex size-10 flex-none items-center justify-center rounded-full border-2 bg-avatar shadow-[0_8px_24px_var(--shade-1)] transition-colors duration-200 hover:border-rose-light lg:size-12 ${
          open ? 'border-rose-light' : 'border-rose/70'
        }`}
      >
        <Flower seed={seed} className="size-[62%]" />
      </button>

      {open ? (
        <div className="fixed top-[84px] right-3 left-3 z-10 mx-auto w-auto max-w-[340px] rounded-petal-sm glass-menu px-5 py-4 text-left shadow-[0_18px_54px_var(--shade-1)] lg:absolute lg:top-[calc(100%+12px)] lg:right-0 lg:left-auto lg:mx-0 lg:w-[260px]">
          <p className="m-0 text-[10.5px] font-semibold tracking-[.1em] text-fg/45 uppercase">Account</p>
          <p className="mt-2 mb-0 truncate font-ui font-normal text-[15px] text-fg">{name}</p>
          {email || detail ? (
            <p className="m-0 mt-1 truncate text-[11.5px] text-fg/55">
              {[email, detail].filter(Boolean).join(' · ')}
            </p>
          ) : null}
          <div className="mt-4 grid gap-1 border-t border-petal-line pt-2.5">
            <Link
              to="/more/profile"
              viewTransition
              onClick={() => setOpen(false)}
              className="rounded-lg px-2 py-2 text-[12px] text-fg/65 no-underline transition-colors hover:bg-fg/5 hover:text-rose-light"
            >
              Your profile
            </Link>
            <button
              type="button"
              onClick={onSignOut}
              className="flex items-center justify-between rounded-lg px-2 py-2 text-left text-[12px] text-fg/55 transition-colors hover:bg-fg/5 hover:text-rose-light"
            >
              Sign out
              <svg
                width="13"
                height="13"
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
          </div>
        </div>
      ) : null}
    </div>
  )
}

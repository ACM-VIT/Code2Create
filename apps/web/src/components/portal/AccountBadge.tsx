import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Flower } from "./FlowerAvatar";

export function AccountBadge({
  name,
  seed,
  email,
  detail,
  onSignOut,
}: {
  name: string;
  seed: string;
  email?: string;
  detail?: string;
  onSignOut: () => void;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !anchor.current?.contains(event.target)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={anchor} className="relative">
      <button
        type="button"
        aria-label={`Account, ${name}`}
        data-ph-sensitive
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={`flex size-10 flex-none items-center justify-center rounded-full border-2 bg-avatar transition-colors duration-250 hover:border-rose-light lg:size-12 ${
          open ? "border-rose-light" : "border-rose/70"
        }`}
      >
        <Flower seed={seed} className="size-[62%]" />
      </button>

      {open ? (
        <div className="absolute top-[calc(100%+12px)] right-0 z-10 w-[240px] max-w-[calc(100vw-40px)] rounded-petal-sm glass-menu px-5 py-4 text-left">
          <p
            className="m-0 truncate font-ui font-normal text-base text-rose-light"
            data-ph-sensitive
          >
            {name}
          </p>
          {email || detail ? (
            <p className="m-0 mt-1 truncate text-[11.5px] text-fg/55" data-ph-sensitive>
              {[email, detail].filter(Boolean).join(" · ")}
            </p>
          ) : null}
          <div className="mt-3 flex items-center justify-between gap-3 border-t border-petal-line pt-2.5">
            <Link
              to="/more"
              viewTransition
              onClick={() => setOpen(false)}
              className="text-[11.5px] text-fg/55 no-underline transition-colors hover:text-rose-light"
            >
              more
            </Link>
            <button
              type="button"
              onClick={onSignOut}
              className="flex items-center gap-2 text-[11.5px] text-fg/55 transition-colors hover:text-rose-light"
            >
              sign out
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
  );
}

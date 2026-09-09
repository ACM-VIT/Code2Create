import { Link } from "react-router-dom";

export type Room = "home" | "music" | "games" | "showcase" | "photos";

/**
 * The room icons.
 *
 * One grid, one stroke weight, one pair of caps: they sit side by side as discs,
 * so any of them drawn heavier or busier than the rest shows immediately. Fills
 * are a wash of the current colour rather than a second tone, so each reads on
 * the rose disc it wears when its room is the one you are in.
 */
const iconStroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

const wash = "color-mix(in srgb, currentColor 16%, transparent)";

const rooms: readonly { key: Room; label: string; to: string; icon: React.ReactNode }[] = [
  {
    key: "home",
    label: "Home",
    to: "/",
    // A house with its door open.
    icon: (
      <svg viewBox="0 0 24 24" className="size-[20px] lg:size-[24px]" aria-hidden>
        <path d="M3.4 10.9 12 4.2l8.6 6.7" {...iconStroke} />
        <path d="M5.9 9.9V19a1 1 0 0 0 1 1h10.2a1 1 0 0 0 1-1V9.9" {...iconStroke} fill={wash} />
        <path d="M9.9 20v-4.3a2.1 2.1 0 0 1 4.2 0V20" {...iconStroke} />
      </svg>
    ),
  },
  {
    key: "music",
    label: "Music",
    to: "/music",
    // Two beamed notes.
    icon: (
      <svg viewBox="0 0 24 24" className="size-[20px] lg:size-[24px]" aria-hidden>
        <path d="M9.6 17.4V6.6l9-2v10.6" {...iconStroke} />
        <path d="M9.6 9.6l9-2" {...iconStroke} />
        <ellipse cx="7.3" cy="17.6" rx="2.4" ry="2.1" fill="currentColor" />
        <ellipse cx="16.3" cy="15.4" rx="2.4" ry="2.1" fill="currentColor" />
      </svg>
    ),
  },
  {
    key: "games",
    label: "Games",
    to: "/games",
    // An origami crane: the arcade belongs to the blossom, not to a console.
    icon: (
      <svg viewBox="0 0 24 24" className="size-[20px] lg:size-[24px]" aria-hidden>
        <path
          d="M3.1 9.5 12.6 4.1l3 6.5 5.3-2.3-4.3 6 -1.5 5.1-3.4-4-5.1 1.4 1.6-4.2z"
          {...iconStroke}
          fill={wash}
        />
        <path d="M12.6 4.1 8.2 12.6m3.5 3.8 4-1.7-.7-3.9" {...iconStroke} strokeWidth={1.4} />
      </svg>
    ),
  },
  {
    key: "showcase",
    label: "Showcase",
    to: "/showcase",
    // A sparkle, with a smaller one trailing it.
    icon: (
      <svg viewBox="0 0 24 24" className="size-[20px] lg:size-[24px]" aria-hidden>
        <path
          d="M10.4 3.6c.8 4.3 2.6 6.1 6.9 6.9-4.3.8-6.1 2.6-6.9 6.9-.8-4.3-2.6-6.1-6.9-6.9 4.3-.8 6.1-2.6 6.9-6.9Z"
          {...iconStroke}
          fill={wash}
        />
        <path
          d="M17.6 15.1c.3 1.9 1.1 2.7 3 3-1.9.3-2.7 1.1-3 3-.3-1.9-1.1-2.7-3-3 1.9-.3 2.7-1.1 3-3Z"
          fill="currentColor"
        />
      </svg>
    ),
  },
  {
    key: "photos",
    label: "Photos",
    to: "/photos",
    icon: <svg viewBox="0 0 24 24" className="size-[20px] lg:size-[24px]" aria-hidden>
      <rect x="3" y="5" width="18" height="15" rx="2" {...iconStroke} />
      <path d="m4 17 5-5 4 4 3-3 4 4" {...iconStroke} />
      <circle cx="16" cy="9" r="1.5" fill="currentColor" />
    </svg>,
  },
];

/**
 * The rooms of the accepted portal, each its own disc.
 *
 * A room is a circle, a little larger than the daybreak toggle so the set reads
 * as the way through the portal rather than as another switch. Reaching for one
 * opens it into a lozenge and the name arrives beside the icon; letting go
 * closes it again. The room you are in stays filled, so where you are is legible
 * without hovering anything.
 *
 * Icons are white throughout, on the glass and on the rose alike, so the disc's
 * fill is what says which room you are in and the drawing never has to carry it.
 *
 * The opening is a grid track going from `0fr` to `1fr` rather than a width
 * growing towards some guessed maximum. A guessed maximum has to be wider than
 * the longest name, so a short one finishes early and the rest of the animation
 * is invisible growth — which reads as a stutter, and reads differently on
 * "Home" than on "Showcase". A track interpolates to the name's own width, so
 * every disc opens at the same pace and stops exactly when it is full.
 *
 * The label is laid out at all times and revealed by width alone, so nothing
 * reflows as it opens and a screen reader reads the name whether or not the
 * pointer has been near it.
 */
export function RoomNav({ current, className = "" }: { current: Room; className?: string }) {
  return (
    <nav aria-label="Rooms" className={`flex w-fit max-w-full items-center gap-2 ${className}`}>
      {rooms.map((room) => {
        const active = room.key === current;
        return (
          <Link
            key={room.key}
            to={room.to}
            viewTransition
            data-room={room.key}
            aria-current={active ? "page" : undefined}
            title={room.label}
            className={`group flex h-11 flex-none items-center rounded-full border-2 px-[10px] font-ui text-[13px] font-semibold tracking-[.01em] text-white no-underline motion-safe:transition-[color,background-color,border-color,box-shadow] motion-safe:duration-[420ms] motion-safe:ease-[cubic-bezier(.22,1,.36,1)] hover:no-underline focus-visible:outline-none lg:h-14 lg:px-[14px] lg:text-[14px] ${
              active
                ? "border-rose bg-rose shadow-[0_10px_26px_-10px_var(--glow-rose)] hover:border-rose-light hover:bg-rose-light"
                : "glass-menu border-rose/70 hover:border-rose-light hover:bg-rose/55 hover:shadow-[0_10px_26px_-10px_var(--glow-rose)]"
            }`}
          >
            <span className="flex flex-none items-center justify-center">{room.icon}</span>
            <span className="grid grid-cols-[0fr] motion-safe:transition-[grid-template-columns] motion-safe:duration-[420ms] motion-safe:ease-[cubic-bezier(.22,1,.36,1)] group-hover:grid-cols-[1fr] group-focus-visible:grid-cols-[1fr]">
              <span className="overflow-hidden whitespace-nowrap">
                <span className="block pr-1 pl-2">{room.label}</span>
              </span>
            </span>
          </Link>
        );
      })}
    </nav>
  );
}

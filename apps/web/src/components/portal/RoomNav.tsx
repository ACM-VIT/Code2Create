import { useLayoutEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

export type Room = "home" | "music" | "games" | "showcase";

const rooms: readonly { key: Room; label: string; to: string; icon: React.ReactNode }[] = [
  {
    key: "home",
    label: "Home",
    to: "/",
    // A small cottage with a blossom for a window: the home tile's mascot.
    icon: (
      <svg viewBox="0 0 24 24" className="size-[18px]" aria-hidden>
        <path
          d="M4 11.2 12 4.5l8 6.7"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M6.2 10.4V19a1 1 0 0 0 1 1h9.6a1 1 0 0 0 1-1v-8.6"
          fill="color-mix(in srgb, currentColor 18%, transparent)"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinejoin="round"
        />
        <g fill="currentColor">
          <circle cx="12" cy="13.2" r="1.15" />
          <circle cx="10.55" cy="14.55" r="1.15" />
          <circle cx="13.45" cy="14.55" r="1.15" />
          <circle cx="11.1" cy="16.2" r="1.15" />
          <circle cx="12.9" cy="16.2" r="1.15" />
        </g>
        <circle cx="12" cy="14.8" r=".75" fill="var(--color-wash)" />
      </svg>
    ),
  },
  {
    key: "music",
    label: "Music",
    to: "/music",
    icon: (
      <svg viewBox="0 0 24 24" className="size-[18px]" aria-hidden>
        <path
          d="M9.5 17.5V6.8l9-2v10.4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="7" cy="17.5" r="2.5" fill="currentColor" />
        <circle cx="16" cy="15.2" r="2.5" fill="currentColor" />
      </svg>
    ),
  },
  {
    key: "games",
    label: "Games",
    to: "/games",
    icon: (
      <svg viewBox="0 0 24 24" className="size-[18px]" aria-hidden>
        <path
          d="M7.2 7h9.6a4.2 4.2 0 0 1 4.15 3.55l.75 4.9a2.6 2.6 0 0 1-4.6 2.05L15.5 15.5h-7l-1.6 2A2.6 2.6 0 0 1 2.3 15.45l.75-4.9A4.2 4.2 0 0 1 7.2 7Z"
          fill="color-mix(in srgb, currentColor 18%, transparent)"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinejoin="round"
        />
        <path d="M8 10v3.4M6.3 11.7h3.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <circle cx="15.4" cy="10.6" r=".95" fill="currentColor" />
        <circle cx="17.4" cy="12.6" r=".95" fill="currentColor" />
      </svg>
    ),
  },
  {
    key: "showcase",
    label: "Showcase",
    to: "/showcase",
    icon: (
      <svg viewBox="0 0 24 24" className="size-[18px]" aria-hidden>
        <path
          d="M12 3.5c.7 4.3 2.8 6.4 7.1 7.1-4.3.7-6.4 2.8-7.1 7.1-.7-4.3-2.8-6.4-7.1-7.1 4.3-.7 6.4-2.8 7.1-7.1Z"
          fill="color-mix(in srgb, currentColor 22%, transparent)"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
        <path d="M18.5 15.5c.3 1.7 1.1 2.5 2.8 2.8-1.7.3-2.5 1.1-2.8 2.8-.3-1.7-1.1-2.5-2.8-2.8 1.7-.3 2.5-1.1 2.8-2.8Z" fill="currentColor" />
      </svg>
    ),
  },
];

/**
 * The rooms of the accepted portal, as one glass pill. A rose lozenge sits
 * under the current room and glides to the next one on hover before the
 * route changes, so the move is answered before the scene swaps.
 */
export function RoomNav({ current, className = "" }: { current: Room; className?: string }) {
  const track = useRef<HTMLElement>(null);
  const [hovered, setHovered] = useState<Room | null>(null);
  const [lozenge, setLozenge] = useState<{ left: number; width: number } | null>(null);
  const target = hovered ?? current;

  useLayoutEffect(() => {
    const nav = track.current;
    if (!nav) return;
    const place = () => {
      const item = nav.querySelector<HTMLElement>(`[data-room="${target}"]`);
      if (!item) return;
      setLozenge({ left: item.offsetLeft, width: item.offsetWidth });
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(nav);
    return () => observer.disconnect();
  }, [target]);

  return (
    <nav
      ref={track}
      aria-label="Rooms"
      onPointerLeave={() => setHovered(null)}
      className={`glass-menu relative isolate flex w-fit max-w-full items-center gap-0.5 rounded-full p-1 ${className}`}
    >
      <span
        aria-hidden
        className="absolute top-1 bottom-1 -z-10 rounded-full bg-rose shadow-[0_8px_22px_-10px_var(--glow-rose)] motion-safe:transition-[left,width,opacity] motion-safe:duration-[380ms] motion-safe:ease-[cubic-bezier(.22,1,.36,1)]"
        style={
          lozenge
            ? { left: lozenge.left, width: lozenge.width, opacity: 1 }
            : { left: 4, width: 0, opacity: 0 }
        }
      />
      {rooms.map((room) => {
        const active = room.key === current;
        const lit = room.key === target;
        return (
          <Link
            key={room.key}
            to={room.to}
            viewTransition
            data-room={room.key}
            aria-current={active ? "page" : undefined}
            onPointerEnter={(event) => {
              if (event.pointerType === "mouse") setHovered(room.key);
            }}
            onFocus={() => setHovered(room.key)}
            onBlur={() => setHovered(null)}
            className={`relative flex items-center gap-2 rounded-full px-3.5 py-2 font-ui text-[13px] font-semibold tracking-[.01em] no-underline transition-colors duration-250 hover:no-underline focus-visible:outline-none sm:px-4 ${
              lit ? "text-wash" : "text-rose-light hover:text-fg"
            }`}
          >
            {room.icon}
            <span className={active || lit ? "" : "sr-only sm:not-sr-only"}>{room.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

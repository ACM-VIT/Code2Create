import { Link, useLocation } from "react-router-dom";

/**
 * The way into the arcade, sitting beside the account badge and the daybreak
 * toggle at the top of every signed-in screen.
 *
 * The games had no entrance at all before this: `/games` was reachable only by
 * typing it. It takes the toggle's shape so the corner reads as one set of
 * controls rather than a button someone bolted on, and an origami crane rather
 * than a controller, which belongs to the blossom the rest of the portal is
 * built from.
 */
export function ArcadeLink() {
  const location = useLocation();
  // Nothing is gained by pointing at the room you are already in.
  if (location.pathname === "/games") return null;

  return (
    <Link
      to="/games"
      viewTransition
      aria-label="Games"
      title="Games"
      className="group flex size-10 flex-none items-center justify-center rounded-full border-2 border-rose/70 bg-avatar text-rose-light transition-colors duration-250 hover:border-rose-light hover:text-fg lg:size-12"
    >
      <svg viewBox="0 0 24 24" aria-hidden className="size-[22px] lg:size-6" fill="none">
        {/* An origami crane: folded wing, body, head and tail. */}
        <path
          d="M3 9.4 12.6 4l3.1 6.6L21 8.2l-4.4 6.1-1.5 5.2-3.5-4.1-5.2 1.4 1.7-4.3z"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
        <path
          d="M12.6 4 8.1 12.5m3.5 3.9 4.1-1.8-.7-4L12.6 4"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinejoin="round"
          opacity=".75"
        />
      </svg>
    </Link>
  );
}

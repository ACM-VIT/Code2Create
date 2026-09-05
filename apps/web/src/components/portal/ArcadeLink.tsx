import { Link, useLocation } from "react-router-dom";

/**
 * The way into the arcade, sitting beside the account badge and the daybreak
 * toggle at the top of every signed-in screen.
 *
 * The games had no entrance at all before this: `/games` was reachable only by
 * typing it. It takes the toggle's shape so the corner reads as one set of
 * controls rather than a button someone bolted on.
 */
export function ArcadeLink() {
  const location = useLocation();
  const here = location.pathname === "/games";
  if (here) return null;

  return (
    <Link
      to="/games"
      viewTransition
      aria-label="Games"
      title="Games"
      className="flex size-10 flex-none items-center justify-center rounded-full border-2 border-rose/70 bg-avatar text-fg/80 transition-colors duration-250 hover:border-rose-light hover:text-fg lg:size-12"
    >
      <svg viewBox="0 0 24 24" aria-hidden className="size-5 lg:size-6" fill="none">
        {/* A game controller: the body, the d-pad, and the two buttons. */}
        <path
          d="M7.2 7.5h9.6a4.2 4.2 0 0 1 4.1 3.3l1 4.6a2.4 2.4 0 0 1-4.3 1.9l-1.3-1.8H7.7l-1.3 1.8a2.4 2.4 0 0 1-4.3-1.9l1-4.6a4.2 4.2 0 0 1 4.1-3.3Z"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
        <path
          d="M7.4 11v2.4M6.2 12.2h2.4"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
        <circle cx="15.6" cy="11.6" r="1.05" fill="currentColor" />
        <circle cx="17.6" cy="13.6" r="1.05" fill="currentColor" />
      </svg>
    </Link>
  );
}

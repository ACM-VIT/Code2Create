import { useConvexConnectionState } from "convex/react";
import { useEffect, useState } from "react";

// How long the live link may be down before we say so. Reconnects after a
// laptop sleep or a theme switch's view transition finish well inside this.
const reconnectGraceMs = 2_500;

/** The browser's own word on whether this device has a network at all. */
function useDeviceOnline() {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const markOnline = () => setOnline(true);
    const markOffline = () => setOnline(false);
    window.addEventListener("online", markOnline);
    window.addEventListener("offline", markOffline);
    return () => {
      window.removeEventListener("online", markOnline);
      window.removeEventListener("offline", markOffline);
    };
  }, []);
  return online;
}

/**
 * A quiet pill at the foot of the screen, only while something is actually
 * wrong: the device has no network, or the live link to the backend has been
 * down long enough to matter. It reads the Convex socket rather than trusting
 * `navigator.onLine` alone — that flag stays true on a captive portal and can
 * flip false on a healthy link — so it appears when live updates really stop.
 */
export function ConnectionNotice() {
  const deviceOnline = useDeviceOnline();
  const connection = useConvexConnectionState();
  const linkDropped = connection.hasEverConnected && !connection.isWebSocketConnected;
  // Each successful connect bumps connectionCount, so it names the current
  // outage: the grace timer records which outage it ran out for, and a fresh
  // drop waits its own grace instead of inheriting the last one's verdict.
  const outage = connection.connectionCount;
  const [graceSpentFor, setGraceSpentFor] = useState<number | null>(null);

  useEffect(() => {
    if (!linkDropped) return;
    const timer = window.setTimeout(() => setGraceSpentFor(outage), reconnectGraceMs);
    return () => window.clearTimeout(timer);
  }, [linkDropped, outage]);

  const reconnecting = linkDropped && graceSpentFor === outage;
  const offline = !deviceOnline;
  if (!offline && !reconnecting) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-[9] flex justify-center px-5">
      <p
        role="status"
        className="pointer-events-auto m-0 flex items-center gap-2.5 rounded-full border border-rose-light/55 bg-wash/85 px-4 py-2 text-[12px] text-fg/85 shadow-[0_12px_30px_-10px_var(--shade-2)] backdrop-blur-md"
      >
        {offline ? (
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            className="text-rose-light"
            aria-hidden
          >
            <path
              d="M4.9 9.8a11.4 11.4 0 0 1 13.7-.5"
              stroke="currentColor"
              strokeLinecap="round"
              strokeWidth="1.8"
            />
            <path
              d="M7.9 13.1a7.2 7.2 0 0 1 7.8-.7"
              stroke="currentColor"
              strokeLinecap="round"
              strokeWidth="1.8"
            />
            <path
              d="M10.8 16.4a2.7 2.7 0 0 1 2.4-.1"
              stroke="currentColor"
              strokeLinecap="round"
              strokeWidth="1.8"
            />
            <path d="M3 3l18 18" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
          </svg>
        ) : (
          <span aria-hidden="true" />
        )}
        {offline ? "offline" : "reconnecting…"}
      </p>
    </div>
  );
}

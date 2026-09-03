import { flushSync } from "react-dom";
import { useEffect, useMemo, useRef, useState } from "react";

import { DelayedBonsai } from "../components/portal/DelayedBonsai";
import { ScreenFixture } from "./screenFixtures";
import { GALLERY_SCREENS } from "./screenList";

// Development-only screen switcher. Mounted from App behind `import.meta.env.DEV`
// via a dynamic import, so neither this nor its fixtures reach a production
// bundle. Lets the portal's screens be reviewed without walking the whole flow.
// Deliberately not persisted: a remembered fixture would silently shadow the
// live app after a reload and swallow every click.
//
// Keys: `[` and `]` step through the screens, Escape leaves the gallery.
const WIDTHS = [
  { id: "full", label: "Full" },
  { id: "desktop", label: "1280", width: 1280 },
  { id: "mobile", label: "390", width: 390 },
] as const;

type WidthId = (typeof WIDTHS)[number]["id"];
type Delay = 0 | 1200;

const panelClass =
  "rounded-[14px] border border-rose/35 bg-wash/92 text-fg shadow-[0_18px_44px_-14px_var(--shade-2)] backdrop-blur-xl";
const chipClass = "rounded-full px-2.5 py-1 text-[11px] transition-colors";
const chipOn = `${chipClass} bg-rose-light text-wash`;
const chipOff = `${chipClass} text-fg/60 hover:bg-fg/8 hover:text-fg`;

export function ScreenGallery() {
  const [open, setOpen] = useState(false);
  const [screenId, setScreenId] = useState<string | null>(null);
  const [pendingScreenId, setPendingScreenId] = useState<string | null>(null);
  const [delay, setDelay] = useState<Delay>(0);
  const [widthId, setWidthId] = useState<WidthId>("full");
  const [query, setQuery] = useState("");
  const pendingTimer = useRef<number | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  const cancelPending = () => {
    if (pendingTimer.current !== null) window.clearTimeout(pendingTimer.current);
    pendingTimer.current = null;
    setPendingScreenId(null);
  };

  const showScreen = (nextScreenId: string | null) => {
    cancelPending();
    const commit = () => {
      const update = () => flushSync(() => setScreenId(nextScreenId));
      if (document.startViewTransition) {
        document.startViewTransition(update);
      } else {
        update();
      }
      setPendingScreenId(null);
      pendingTimer.current = null;
    };
    if (delay === 0 || nextScreenId === null || screenId === null) {
      commit();
      return;
    }
    setPendingScreenId(nextScreenId);
    pendingTimer.current = window.setTimeout(commit, delay);
  };

  const active = GALLERY_SCREENS.find((screen) => screen.id === screenId) ?? null;
  const activeIndex = active ? GALLERY_SCREENS.indexOf(active) : -1;
  const previous = activeIndex > 0 ? GALLERY_SCREENS[activeIndex - 1] : null;
  const next =
    activeIndex >= 0 && activeIndex < GALLERY_SCREENS.length - 1 ? GALLERY_SCREENS[activeIndex + 1] : null;
  const width = WIDTHS.find((option) => option.id === widthId);
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return GALLERY_SCREENS;
    return GALLERY_SCREENS.filter(
      (screen) => screen.id.toLowerCase().includes(needle) || screen.label.toLowerCase().includes(needle),
    );
  }, [query]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const typing = event.target instanceof HTMLElement && event.target.closest("input, textarea, [contenteditable]");
      if (event.key === "Escape") {
        cancelPending();
        setScreenId(null);
        setOpen(false);
        return;
      }
      if (typing || screenId === null || pendingScreenId !== null) return;
      if (event.key === "]" && next) showScreen(next.id);
      if (event.key === "[" && previous) showScreen(previous.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  useEffect(() => () => {
    if (pendingTimer.current !== null) window.clearTimeout(pendingTimer.current);
  }, []);

  useEffect(() => {
    if (open) searchRef.current?.focus();
  }, [open]);

  return (
    <>
      {active ? (
        <div className="fixed inset-0 z-[9998] overflow-auto bg-wash">
          <div
            className="mx-auto min-h-full"
            style={width && "width" in width ? { maxWidth: `${width.width}px` } : undefined}
          >
            <ScreenFixture id={active.id} />
          </div>
          {pendingScreenId ? (
            <div className="fixed inset-0 z-[9998] grid place-items-center bg-wash/25 backdrop-blur-[12px]">
              <DelayedBonsai />
            </div>
          ) : null}
          <div
            className={`fixed bottom-3 left-1/2 z-[9999] flex -translate-x-1/2 items-center gap-1 px-1.5 py-1 font-ui text-[12px] ${panelClass}`}
          >
            <button
              type="button"
              disabled={!previous || pendingScreenId !== null}
              onClick={() => previous && showScreen(previous.id)}
              aria-label="Previous screen"
              className="rounded-full px-2.5 py-1 text-fg/70 hover:bg-fg/8 hover:text-fg disabled:opacity-25"
            >
              ←
            </button>
            <span className="px-2 text-fg/85">
              {pendingScreenId ? `holding ${delay}ms` : active.label}
              <span className="ml-2 font-mono text-[10.5px] text-fg/45">{active.id}</span>
            </span>
            <button
              type="button"
              disabled={!next || pendingScreenId !== null}
              onClick={() => next && showScreen(next.id)}
              aria-label="Next screen"
              className="rounded-full px-2.5 py-1 text-fg/70 hover:bg-fg/8 hover:text-fg disabled:opacity-25"
            >
              →
            </button>
            <button
              type="button"
              onClick={() => showScreen(null)}
              aria-label="Leave the gallery"
              className="ml-1 rounded-full px-2.5 py-1 text-fg/70 hover:bg-fg/8 hover:text-fg"
            >
              ×
            </button>
          </div>
        </div>
      ) : null}

      <div data-dev-gallery className="fixed bottom-3 left-3 z-[9999] font-ui">
        {open ? (
          <div className={`mb-2 flex w-[272px] flex-col overflow-hidden ${panelClass}`}>
            <div className="border-b border-rose/25 p-2">
              <input
                ref={searchRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Find a screen"
                className="h-8 w-full rounded-[9px] border border-rose/35 bg-wash/60 px-2.5 text-[12px] text-fg outline-none placeholder:text-fg/40 focus:border-rose-light"
              />
            </div>
            <div className="max-h-[52vh] overflow-y-auto py-1 [scrollbar-width:thin]">
              <button
                type="button"
                onClick={() => showScreen(null)}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] ${
                  active === null ? "text-rose-light" : "text-fg/70 hover:bg-fg/6 hover:text-fg"
                }`}
              >
                <span className="w-[74px] flex-none font-mono text-[10.5px] text-fg/40">live</span>
                Live app
              </button>
              {matches.map((screen) => (
                <button
                  key={screen.id}
                  type="button"
                  disabled={pendingScreenId !== null}
                  onClick={() => showScreen(screen.id)}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] ${
                    screenId === screen.id ? "bg-rose-light/12 text-rose-light" : "text-fg/70 hover:bg-fg/6 hover:text-fg"
                  }`}
                >
                  <span className="w-[74px] flex-none truncate font-mono text-[10.5px] text-fg/40">{screen.id}</span>
                  <span className="truncate">{screen.label}</span>
                </button>
              ))}
              {matches.length === 0 ? <p className="m-0 px-3 py-2 text-[12px] text-fg/45">No screen matches.</p> : null}
            </div>
            <div className="flex flex-col gap-1.5 border-t border-rose/25 p-2">
              <div className="flex items-center gap-1">
                <span className="mr-auto pl-1 text-[10.5px] text-fg/40">width</span>
                {WIDTHS.map((option) => (
                  <button key={option.id} type="button" onClick={() => setWidthId(option.id)} className={widthId === option.id ? chipOn : chipOff}>
                    {option.label}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-1">
                <span className="mr-auto pl-1 text-[10.5px] text-fg/40">route delay</span>
                {([0, 1200] as const).map((option) => (
                  <button key={option} type="button" onClick={() => setDelay(option)} className={delay === option ? chipOn : chipOff}>
                    {option === 0 ? "off" : "1.2s"}
                  </button>
                ))}
              </div>
              <p className="m-0 pl-1 text-[10.5px] text-fg/35">[ and ] step · Esc leaves</p>
            </div>
          </div>
        ) : null}

        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className={`px-3 py-1.5 text-[12px] text-fg/75 hover:text-fg ${panelClass}`}
        >
          ◧ {pendingScreenId ? `${active?.id ?? "mock"} → ${pendingScreenId}` : active ? active.id : "screens"}
        </button>
      </div>
    </>
  );
}

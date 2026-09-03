import { useSyncExternalStore } from "react";

/**
 * The portal renders one scene in two lights: 'night' (yozakura — blossoms by
 * lantern light, the default) and 'daybreak' (the same garden at first light).
 * The choice lives on <html data-theme> so a single CSS override block in
 * index.css repaints every token, and it persists per browser.
 */
export type PortalTheme = "night" | "daybreak";

const storageKey = "code2create.portal-theme";
const themeColors: Record<PortalTheme, string> = {
  night: "#0c0004",
  daybreak: "#cfc5e4",
};

let currentTheme: PortalTheme = "night";
const listeners = new Set<() => void>();

function readStoredTheme(): PortalTheme {
  try {
    return localStorage.getItem(storageKey) === "daybreak" ? "daybreak" : "night";
  } catch {
    return "night";
  }
}

function applyTheme(theme: PortalTheme) {
  currentTheme = theme;
  if (theme === "daybreak") document.documentElement.setAttribute("data-theme", "daybreak");
  else document.documentElement.removeAttribute("data-theme");
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", themeColors[theme]);
}

/** Called once from main.tsx, before first render, so there is no flash. */
export function initPortalTheme() {
  applyTheme(readStoredTheme());
  // Another tab flipping the light flips this one too.
  window.addEventListener("storage", (event) => {
    if (event.key !== storageKey) return;
    applyTheme(readStoredTheme());
    for (const listener of listeners) listener();
  });
}

export function getPortalTheme(): PortalTheme {
  return currentTheme;
}

export function setPortalTheme(theme: PortalTheme) {
  if (theme === currentTheme) return;
  try {
    localStorage.setItem(storageKey, theme);
  } catch {
    // A private window without storage still switches; it just won't stick.
  }

  const swap = () => {
    applyTheme(theme);
    for (const listener of listeners) listener();
  };

  // The dawn breaks as a crossfade where the browser supports view
  // transitions; elsewhere (and under reduced motion) it is instant.
  const transition = (
    document as Document & { startViewTransition?: (update: () => void) => void }
  ).startViewTransition;
  if (transition && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    transition.call(document, swap);
  } else {
    swap();
  }
}

export function togglePortalTheme() {
  setPortalTheme(currentTheme === "night" ? "daybreak" : "night");
}

export function usePortalTheme(): PortalTheme {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getPortalTheme,
    () => "night" as const,
  );
}

import { isChunkLoadFailure } from "@code2create/client-observability";
import { Suspense, lazy, useState, useSyncExternalStore } from "react";

const TreeLoader = lazy(async () => {
  try {
    const module = await import("./TreeLoader");
    return { default: module.TreeLoader };
  } catch (error) {
    if (!isChunkLoadFailure(error)) throw error;
    return { default: () => <></> };
  }
});

const revealDelay = 300;
const continuityWindow = 100;

// Loading moves through several independently mounted query and lazy-route
// fallbacks. Keep one reveal clock across adjacent mounts so an already-visible
// bonsai does not disappear and restart between those phases.
const visibilityListeners = new Set<() => void>();
let visible = false;
let revealTimer: number | null = null;
let releaseTimer: number | null = null;

function emitVisibility() {
  for (const listener of visibilityListeners) listener();
}

function subscribeToVisibility(listener: () => void) {
  visibilityListeners.add(listener);
  if (releaseTimer !== null) {
    window.clearTimeout(releaseTimer);
    releaseTimer = null;
  }
  if (!visible && revealTimer === null) {
    revealTimer = window.setTimeout(() => {
      revealTimer = null;
      visible = true;
      emitVisibility();
    }, revealDelay);
  }

  return () => {
    visibilityListeners.delete(listener);
    if (visibilityListeners.size > 0 || releaseTimer !== null) return;
    releaseTimer = window.setTimeout(() => {
      releaseTimer = null;
      if (visibilityListeners.size > 0) return;
      if (revealTimer !== null) window.clearTimeout(revealTimer);
      revealTimer = null;
      visible = false;
    }, continuityWindow);
  };
}

function visibilitySnapshot() {
  return visible;
}

export function DelayedBonsai({
  compact = false,
  label = "just a moment",
}: {
  compact?: boolean;
  label?: string;
}) {
  const [continuesVisibleLoader] = useState(visibilitySnapshot);
  const loaderVisible = useSyncExternalStore(
    subscribeToVisibility,
    visibilitySnapshot,
    () => false,
  );

  if (!loaderVisible) return null;

  return (
    <div
      className={`delayed-bonsai${compact ? " delayed-bonsai-compact" : ""}`}
      data-continuing={continuesVisibleLoader ? "true" : undefined}
    >
      <Suspense fallback={null}>
        <TreeLoader label={label} variant={compact ? "shell" : "scene"} />
      </Suspense>
    </div>
  );
}

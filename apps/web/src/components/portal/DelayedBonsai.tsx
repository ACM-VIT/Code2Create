import { Component, Suspense, lazy, useEffect, useState } from "react";
import type { ReactNode } from "react";

const TreeLoader = lazy(() =>
  import("./TreeLoader").then((module) => ({ default: module.TreeLoader })),
);

const revealDelay = 300;

/* The loader is decoration. When its chunk fails to load, render nothing so a
   missing animation degrades silently instead of climbing to the app-wide
   error boundary and replacing the whole screen. */
class SilentDecoration extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    return this.state.failed ? null : this.props.children;
  }
}

export function DelayedBonsai({
  compact = false,
  label = "just a moment",
}: {
  compact?: boolean;
  label?: string;
}) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setVisible(true), revealDelay);
    return () => window.clearTimeout(timer);
  }, []);

  if (!visible) return null;

  return (
    <div className={`delayed-bonsai${compact ? " delayed-bonsai-compact" : ""}`}>
      <SilentDecoration>
        <Suspense fallback={null}>
          <TreeLoader label={label} variant={compact ? "shell" : "scene"} />
        </Suspense>
      </SilentDecoration>
    </div>
  );
}

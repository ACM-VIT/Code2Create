import { isChunkLoadFailure, useProductAnalytics } from "@code2create/client-observability";
import { Component, Suspense, lazy, useEffect, useState } from "react";
import type { ReactNode } from "react";

const TreeLoader = lazy(() =>
  import("./TreeLoader").then((module) => ({ default: module.TreeLoader })),
);

const revealDelay = 300;

/* The loader is decoration, so a failure never takes down the screen: render
   nothing instead of climbing to the app-wide error boundary. A missing chunk
   degrades silently, but a genuine render bug in the loader is still reported so
   the regression stays visible in error tracking. */
class SilentDecoration extends Component<
  { children: ReactNode; onError: (error: unknown) => void },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(error: unknown) {
    if (!isChunkLoadFailure(error)) {
      this.props.onError(error);
    }
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
  const { captureException } = useProductAnalytics();

  useEffect(() => {
    const timer = window.setTimeout(() => setVisible(true), revealDelay);
    return () => window.clearTimeout(timer);
  }, []);

  if (!visible) return null;

  return (
    <div className={`delayed-bonsai${compact ? " delayed-bonsai-compact" : ""}`}>
      <SilentDecoration onError={captureException}>
        <Suspense fallback={null}>
          <TreeLoader label={label} variant={compact ? "shell" : "scene"} />
        </Suspense>
      </SilentDecoration>
    </div>
  );
}

import { Suspense, lazy, useEffect, useState } from "react";

const TreeLoader = lazy(() =>
  import("./TreeLoader").then((module) => ({ default: module.TreeLoader })),
);

const revealDelay = 300;

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
      <Suspense fallback={null}>
        <TreeLoader label={label} variant={compact ? "shell" : "scene"} />
      </Suspense>
    </div>
  );
}

import { useEffect, useState } from "react";

export function useEstimatedServerNow(serverNow: number | undefined, updateIntervalMs = 1_000) {
  const [clock, setClock] = useState({
    sourceServerNow: serverNow,
    estimatedServerNow: serverNow ?? 0,
  });

  useEffect(() => {
    if (serverNow === undefined) return;
    const observedAt = performance.now();
    const timer = setInterval(
      () =>
        setClock({
          sourceServerNow: serverNow,
          estimatedServerNow: serverNow + performance.now() - observedAt,
        }),
      updateIntervalMs,
    );
    return () => clearInterval(timer);
  }, [serverNow, updateIntervalMs]);

  return clock.sourceServerNow === serverNow ? clock.estimatedServerNow : (serverNow ?? 0);
}

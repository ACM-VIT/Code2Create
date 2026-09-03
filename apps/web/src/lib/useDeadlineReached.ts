import { useEffect, useState } from "react";

import { scheduleDeadline } from "./time";

export function useDeadlineReached(serverNow: number, deadline: number | undefined) {
  const [elapsedDeadline, setElapsedDeadline] = useState<number | null>(null);

  useEffect(() => {
    if (deadline === undefined || serverNow >= deadline) return;
    const clientStartedAt = performance.now();
    return scheduleDeadline(
      deadline,
      () => serverNow + performance.now() - clientStartedAt,
      () => setElapsedDeadline(deadline),
    );
  }, [deadline, serverNow]);

  return deadline !== undefined && (serverNow >= deadline || elapsedDeadline === deadline);
}

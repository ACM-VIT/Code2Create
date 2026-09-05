import { LiveNumber } from "./LiveNumber";
import { queueWaitRange } from "../lib/time";

export function LiveQueueWait({ estimate, now }: {
  estimate: { earliestAt: number; latestAt: number };
  now: number;
}) {
  const range = queueWaitRange(estimate, now);
  if (range === null) return "Taking longer than estimated";
  return range.lower === 0 ? (
    <>Within <LiveNumber value={range.upper} /> min</>
  ) : (
    <>About <LiveNumber value={range.lower} />–<LiveNumber value={range.upper} /> min</>
  );
}

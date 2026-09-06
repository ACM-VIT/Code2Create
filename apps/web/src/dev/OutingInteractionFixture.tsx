import { useState } from "react";
import { ServiceQueuesTile } from "../components/dashboard/ServiceQueuesTile";
import { outingFixture } from "./outingFixture";

export function OutingInteractionFixture() {
  const params = new URLSearchParams(location.search);
  const full = params.has("full");
  const compact = params.has("compact");
  const [service, setService] = useState(() => outingFixture({ occupiedCount: full ? 15 : 0 }));
  const grant = () => setService((current) => ({ ...current, status: "permitted", canRequest: false, position: null,
    waitingCount: 0, occupiedCount: 15, serverNow: Date.now(), permissionExpiresAt: Date.now() + 900_000 }));
  return <>
    <div className="flex flex-wrap gap-3" aria-label="Fixture controls">
      <button type="button" onClick={grant}>Release another person’s slot</button>
      <button type="button" onClick={() => setService((current) => ({ ...current, status: "out", canRequest: false,
        serverNow: Date.now(), returnBy: Date.now() + 900_000 }))}>Scan departure</button>
      <button type="button" onClick={() => setService(outingFixture())}>Scan return</button>
    </div>
    <div className={`mt-4 flex [&>div]:flex-1 ${compact ? "h-[112px] w-[170px]" : "h-[300px] w-[320px]"}`} data-testid="outing-tile">
      <ServiceQueuesTile slot="garden" model={{ available: true, pending: false, services: [service],
        setServiceQueue: async (_kind, joined) => {
          if (!joined) { setService(outingFixture({ occupiedCount: full ? 15 : 0 })); return; }
          if (full) setService((current) => ({ ...current, status: "waiting", canRequest: false, position: 1, waitingCount: 1 }));
          else grant();
        },
      }} />
    </div>
  </>;
}

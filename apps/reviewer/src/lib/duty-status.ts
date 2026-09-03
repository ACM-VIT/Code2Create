import { api } from "@code2create/backend/api";
import { useQuery } from "convex/react";
import { useEffect, useState, useSyncExternalStore } from "react";

import { installationRevision, subscribeToInstallationChanges } from "@/lib/installation-state";
import { loadReviewerDevice } from "@/lib/reviewer-device";
import { loadScannerDevice } from "@/lib/scanner-device";
import { hallStatus, helpStatus, incidentStatus, type DutyStatus } from "@/lib/judging-status";

export type { DutyStatus } from "@/lib/judging-status";

export function useReviewerInstallationId(eventSlug: string) {
  return useInstallationIds(eventSlug).reviewer;
}

function useInstallationIds(eventSlug: string) {
  const [ids, setIds] = useState<{ reviewer?: string; scanner?: string }>({});
  const revision = useSyncExternalStore(
    (listener) => subscribeToInstallationChanges(eventSlug, listener),
    () => installationRevision(eventSlug),
  );
  useEffect(() => {
    let cancelled = false;
    const read = async () => {
      try {
        const [reviewer, scanner] = await Promise.all([
          loadReviewerDevice(eventSlug),
          loadScannerDevice(eventSlug),
        ]);
        if (cancelled) return;
        setIds({
          ...(reviewer ? { reviewer: reviewer.installationId } : {}),
          ...(scanner ? { scanner: scanner.installationId } : {}),
        });
      } catch {
        if (!cancelled) setIds({});
      }
    };
    void read();
    return () => {
      cancelled = true;
    };
  }, [eventSlug, revision]);
  return ids;
}

export function useDoorStatus(eventSlug: string, enabled: boolean): DutyStatus {
  const { scanner } = useInstallationIds(eventSlug);
  const current = useQuery(
    api.attendanceScanner.current,
    enabled && scanner ? { eventSlug, installationId: scanner } : "skip",
  );
  if (!enabled) return { status: "", active: false };
  if (current === undefined) return { status: "—", active: false };
  if (current === null) return { status: "Pick a station", active: false };
  const sent = current.device.lastSequence;
  const pending = current.device.pendingReplayCount;
  if (pending > 0) {
    return {
      status: `${pending} to send`,
      active: true,
      headline: { value: String(pending), unit: "to send" },
    };
  }
  // Omit progress when no scans are pending; a full bar implies active work.
  return {
    status: current.station.name,
    active: true,
    headline: { value: String(sent), unit: sent === 1 ? "scan sent" : "scans sent" },
  };
}

export function useHallStatus(eventSlug: string, enabled: boolean): DutyStatus {
  const summary = useQuery(api.floorMapping.summary, enabled ? { eventSlug } : "skip");
  return hallStatus(summary, enabled);
}

export function usePulseStatus(eventSlug: string, enabled: boolean): DutyStatus {
  const attention = useQuery(api.operationsAttention.overview, enabled ? { eventSlug } : "skip");
  if (!enabled) return { status: "", active: false };
  if (attention === undefined) return { status: "—", active: false };
  const unclaimed = attention.summary.rowCount - attention.summary.acknowledgedCount;
  if (unclaimed > 0) {
    return {
      status: attention.summary.hasMore
        ? `${unclaimed} shown need${unclaimed === 1 ? "s" : ""} someone`
        : `${unclaimed} need${unclaimed === 1 ? "s" : ""} someone`,
      active: true,
      headline: {
        value: String(unclaimed),
        unit: attention.summary.hasMore
          ? unclaimed === 1
            ? "shown needs someone"
            : "shown need someone"
          : unclaimed === 1
            ? "needs someone"
            : "need someone",
      },
    };
  }
  if (attention.summary.hasMore) return { status: "More items waiting", active: true };
  if (attention.summary.rowCount > 0) return { status: "All picked up", active: false };
  return { status: "All clear", active: false };
}

export function useIncidentStatus(eventSlug: string, enabled: boolean): DutyStatus {
  const summary = useQuery(api.incidents.activeSummary, enabled ? { eventSlug } : "skip");
  return incidentStatus(summary, enabled);
}

export function useHelpStatus(eventSlug: string, enabled: boolean): DutyStatus {
  const summary = useQuery(api.support.mineSummary, enabled ? { eventSlug } : "skip");
  return helpStatus(summary, enabled);
}

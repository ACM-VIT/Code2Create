import { api } from "@code2create/backend/api";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useState } from "react";

import { eventSlug } from "../lib/config";
import { formatCompactDateTime } from "../lib/dateTime";
import { isConvexErrorCode, readableError } from "../lib/errors";
import { useOperationRunner } from "../lib/operations";
import { briefStreamObserverKey } from "../lib/operationsBrief";
import { Icon, type IconName } from "./Icon";
import { OperationsBriefStream } from "./OperationsBriefStream";

type Severity = "watch" | "attention" | "critical";

/** The latest operator brief: current issues, owners, and next actions from a frozen snapshot. */
export function OperationsBrief({
  canGenerate,
  canRead,
}: {
  canGenerate: boolean;
  canRead: boolean;
}) {
  const brief = useQuery(api.operationsIntelligence.latest, canRead ? { eventSlug } : "skip");
  const requestBrief = useMutation(api.operationsIntelligence.request);
  const requestHealthRefresh = useMutation(api.operationsHealth.requestRefresh);
  const operations =
    useOperationRunner<FunctionReturnType<typeof api.operationsIntelligence.request>>();
  const [requesting, setRequesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [tracePreference, setTracePreference] = useState<{
    briefId: string | undefined;
    open: boolean;
  }>({ briefId: undefined, open: false });

  const generate = async () => {
    setRequesting(true);
    setError(null);
    setMessage(null);
    try {
      await operations.run(
        "request",
        (clientOperationId) => () => requestBrief({ eventSlug, clientOperationId }),
      );
      setMessage(
        canRead
          ? "Requested. The brief appears here when the agent finishes."
          : "Requested. Someone with read access can review it.",
      );
    } catch (caught) {
      setError(readableError(caught));
      if (
        isConvexErrorCode(caught, "OPERATIONS_HEALTH_NOT_READY") ||
        isConvexErrorCode(caught, "OPERATIONS_HEALTH_STALE")
      ) {
        // The brief is grounded in the event-wide checks, which now refresh only on demand.
        requestHealthRefresh({ eventSlug }).catch((refreshCaught: unknown) => {
          setError(readableError(refreshCaught));
        });
      }
    } finally {
      setRequesting(false);
    }
  };

  const inProgress =
    brief?.state === "pending" || brief?.state === "dispatching" || brief?.state === "accepted";
  const requestPending = operations.hasPending("request");
  const currentBriefId = brief?.id;
  const traceOpen =
    tracePreference.briefId === currentBriefId
      ? tracePreference.open
      : currentBriefId !== undefined && inProgress;
  const requestButton = canGenerate ? (
    <button
      className="secondary"
      disabled={requesting || (inProgress && !requestPending)}
      onClick={() => void generate()}
      type="button"
    >
      {requesting
        ? "Requesting…"
        : requestPending
          ? "Confirm earlier request"
          : inProgress
            ? "Preparing…"
            : brief
              ? "Prepare a new brief"
              : "Prepare a brief"}
    </button>
  ) : null;

  return (
    <section aria-labelledby="latest-brief-heading" className="attention-section" id="latest-brief">
      <div className="section-heading">
        <h2 id="latest-brief-heading">Latest brief</h2>
        {canRead && brief?.state === "succeeded" ? (
          <span>
            {brief.completedAt
              ? `Published ${formatCompactDateTime(brief.completedAt)}`
              : `Requested ${formatCompactDateTime(brief.requestedAt)}`}
          </span>
        ) : null}
      </div>
      {error ? (
        <p className="notice error" role="alert">
          {error}
        </p>
      ) : null}
      {message ? (
        <p className="notice" role="status">
          {message}
        </p>
      ) : null}

      {!canRead ? (
        <div className="grid gap-3">
          <p className="m-0 text-[13px] text-ink-3">
            You can request a brief; reading it needs the intelligence read permission.
          </p>
          {requestButton}
        </div>
      ) : brief === undefined ? (
        <p className="m-0 text-[13px] text-ink-3" role="status">
          Loading the latest brief…
        </p>
      ) : brief === null ? (
        <div className="grid gap-3">
          <div className="health-empty">
            <strong>No brief yet.</strong>
            <span>A brief is a short summary of what needs attention and who should act.</span>
          </div>
          {requestButton}
        </div>
      ) : (
        <div className="grid gap-3">
          {brief.state === "succeeded" ? (
            <>
              <div className="grid gap-1 px-0.5">
                <strong className="text-[13px] font-medium text-ink">{brief.headline}</strong>
                <p className="m-0 text-[13px] leading-6 text-ink-2">{brief.summary}</p>
              </div>
              {brief.priorities.length > 0 ? (
                <ol className="health-list m-0 list-none p-0">
                  {brief.priorities.map((priority) => (
                    <li
                      className={`list-row ${priority.severity}`}
                      key={priority.signalKeys.join(":")}
                    >
                      <span className={`row-glyph ${priority.severity}`}>
                        <Icon name={severityIcon(priority.severity)} />
                      </span>
                      <div className="row-text">
                        <strong>{priority.title}</strong>
                        <small>{priority.why}</small>
                        <small>
                          {priority.owner} · {priority.nextAction}
                        </small>
                      </div>
                      <span className="state-label">{severityLabel(priority.severity)}</span>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="m-0 text-[13px] text-ink-3">
                  Nothing needed a priority in that snapshot.
                </p>
              )}
            </>
          ) : brief.state === "failed" ? (
            <p className="notice error">The brief could not be prepared.</p>
          ) : (
            <p className="m-0 text-[13px] text-ink-3" role="status">
              Preparing from a frozen copy of the current health signals…
            </p>
          )}
          <div className="flex flex-wrap items-center gap-3">
            {requestButton}
            <button
              className="text-button text-[12px]"
              onClick={() => setTracePreference({ briefId: currentBriefId, open: !traceOpen })}
              type="button"
            >
              {traceOpen
                ? "Hide the agent's steps"
                : inProgress
                  ? "Watch the agent work"
                  : "See the agent's steps"}
            </button>
          </div>
          {traceOpen ? (
            <OperationsBriefStream
              briefId={brief.id}
              isActive={inProgress}
              key={briefStreamObserverKey(brief.id, brief.workerAcceptedAt)}
            />
          ) : null}
        </div>
      )}
    </section>
  );
}

function severityLabel(value: Severity) {
  if (value === "attention") return "Needs attention";
  if (value === "critical") return "Critical";
  return "Watch";
}

function severityIcon(value: Severity): IconName {
  return value === "watch" ? "pulse" : "alert";
}

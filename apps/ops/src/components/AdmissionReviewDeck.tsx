import { api } from "@code2create/backend/api";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";

import { teamOriginFilterLabels, teamOriginFilters, teamOriginQueryArgs, type TeamOriginFilter } from "../lib/admissionsPresentation";
import { eventSlug } from "../lib/config";
import { readableError } from "../lib/errors";
import { useOperationRunner } from "../lib/operations";
import { LiveNumber } from "./LiveNumber";
import { LoadingLabel, SkeletonCard } from "./Skeleton";

type DeckItem = NonNullable<FunctionReturnType<typeof api.admissions.reviewDeck>>[number];

function useReviewDeck(origin: TeamOriginFilter, excludeApplicationId?: DeckItem["applicationId"]) {
  const currentMinute = () => Math.floor(Date.now() / 60_000) * 60_000;
  const [now, setNow] = useState(currentMinute);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(currentMinute()), 15_000);
    return () => window.clearInterval(timer);
  }, []);
  return useQuery(api.admissions.reviewDeck, {
    eventSlug, now, ...teamOriginQueryArgs(origin),
    ...(excludeApplicationId ? { excludeApplicationId } : {}),
  });
}

export function AdmissionReviewDeck({ origin, onOriginChange, showReviewCounts = true }: {
  origin: TeamOriginFilter;
  onOriginChange: (origin: TeamOriginFilter) => void;
  showReviewCounts?: boolean;
}) {
  const deck = useReviewDeck(origin);
  if (deck === null) return null;
  return (
    <section className="admission-deck" id="review-deck" aria-labelledby="review-deck-heading">
      <div className="admission-deck-heading">
        <h2 id="review-deck-heading">Your review deck</h2>
        <div className="stage-filter admissions-origins" role="group" aria-label="Review deck team type">
          {teamOriginFilters.map((candidate) => (
            <button key={candidate} type="button" aria-pressed={origin === candidate}
              className={origin === candidate ? "stage-chip active" : "stage-chip"}
              onClick={() => onOriginChange(candidate)}>
              {teamOriginFilterLabels[candidate]}
            </button>
          ))}
        </div>
      </div>
      {deck === undefined ? (
        <>
          <LoadingLabel>Loading your review deck</LoadingLabel>
          <div className="admission-deck-grid">{[0, 1, 2, 3].map((slot) => <SkeletonCard key={slot} lines={4} />)}</div>
        </>
      ) : deck.length === 0 ? (
        <p className="admission-deck-empty" role="status">No submissions available to review.</p>
      ) : (
        <div className="admission-deck-grid">
          {deck.map((item) => <ReviewCard key={item.applicationId} item={item} showReviewCounts={showReviewCounts} />)}
        </div>
      )}
    </section>
  );
}

function ReviewCard({ item, showReviewCounts }: { item: DeckItem; showReviewCounts: boolean }) {
  const cancel = useMutation(api.admissions.cancelReviewAssignment);
  const operations = useOperationRunner();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const assignment = item.assignment;
  const release = async () => {
    if (!assignment) return;
    setBusy(true);
    setError(null);
    try {
      await operations.run("release", (clientOperationId) => {
        const command = {
          eventSlug, applicationId: item.applicationId, expectedApplicationVersion: item.applicationVersion,
          assignmentId: assignment.id, expectedAssignmentVersion: assignment.version,
          reason: "Released my review claim", clientOperationId,
        };
        return () => cancel(command);
      });
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setBusy(false);
    }
  };
  return (
    <article className={`admission-deck-card${assignment ? " claimed" : ""}`}>
      <div className="admission-deck-card-status">
        <span className={`admission-tag${assignment ? " accept" : ""}`}>{assignment ? "Claimed by you" : "Available"}</span>
        {assignment ? <time dateTime={new Date(assignment.expiresAt).toISOString()}>
          Until {new Date(assignment.expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
        </time> : null}
      </div>
      <h3>{item.teamName}</h3>
      <p className="admission-deck-idea">{item.idea}</p>
      <div className="admission-deck-card-meta">
        <span>{item.memberCount} {item.memberCount === 1 ? "member" : "members"}</span>
        {showReviewCounts ? <span><LiveNumber value={item.completedReviewCount} />/{item.minimumHumanReviews} reviews</span> : null}
      </div>
      <div className="admission-deck-actions">
        <ReviewAction item={item} />
        {assignment ? <button type="button" className="admission-deck-release" disabled={busy} onClick={() => void release()}>
          {busy ? "Releasing…" : operations.hasPending("release") ? "Retry release" : "Release claim"}
        </button> : null}
      </div>
      {error ? <p className="notice error" role="alert">{error}</p> : null}
    </article>
  );
}

function ReviewAction({ item, className = "primary", label }: { item: DeckItem; className?: string; label?: string }) {
  const claim = useMutation(api.admissions.claimReview);
  const operations = useOperationRunner<FunctionReturnType<typeof api.admissions.claimReview>>();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await operations.run("claim", (clientOperationId) => {
        const command = { eventSlug, applicationId: item.applicationId, clientOperationId };
        return () => claim(command);
      });
      if (result.assignmentState !== "active") {
        setError("This claim has ended. Choose another submission.");
        return;
      }
      await navigate(`/admissions/${result.applicationId}`);
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {item.assignment && !operations.hasPending("claim") ? (
        <Link className={className} to={`/admissions/${item.applicationId}`}>{label ?? "Continue →"}</Link>
      ) : (
        <button type="button" className={className} disabled={busy} onClick={() => void open()}>
          {busy ? "Claiming…" : operations.hasPending("claim") ? "Retry claim" : label ?? "Claim & review →"}
        </button>
      )}
      {error ? <p className="notice error" role="alert">{error}</p> : null}
    </>
  );
}

export function NextReviewButton({ currentApplicationId, className, label, fallback }: {
  currentApplicationId: DeckItem["applicationId"];
  className: string;
  label: string;
  fallback?: ReactNode;
}) {
  const deck = useReviewDeck("all", currentApplicationId);
  const next = deck?.[0];
  return next ? <ReviewAction key={next.applicationId} item={next} className={className} label={label} />
    : deck === undefined ? null : fallback;
}

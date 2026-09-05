import { LiveNumber } from "./LiveNumber";
import { api } from "@code2create/backend/api";
import { useQuery } from "convex/react";

import { eventSlug } from "../lib/config";

const scoreFormat = { maximumFractionDigits: 2 } satisfies Intl.NumberFormatOptions;
const dateFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});

export function ReleasedFeedbackPanel() {
  const releases = useQuery(api.scoreGovernance.participantFeedback, { eventSlug });

  if (releases === undefined) {
    return null;
  }
  if (releases.length === 0) return null;

  return (
    <section className="attendance-panel" aria-labelledby="released-feedback-heading">
      <div>
        <p className="eyebrow">Released feedback</p>
        <h2 id="released-feedback-heading">Your review</h2>
        <p className="muted">Only the fields the organisers chose to share appear here.</p>
      </div>
      <div className="released-feedback-list">
        {releases.map((release) => (
          <article key={release.roundId}>
            <div className="feedback-heading">
              <strong>{release.roundName}</strong>
              <span>{formatTime(release.publishedAt)}</span>
            </div>
            {release.totalScore !== undefined ? (
              <p className="feedback-total">
                <LiveNumber value={release.totalScore} format={scoreFormat} /> <span>/ 100</span>
              </p>
            ) : null}
            {release.criteria.length > 0 ? (
              <dl className="detail-list compact-details">
                {release.criteria.map((criterion) => (
                  <div key={criterion.criterionId}>
                    <dt>{criterion.label}</dt>
                    <dd><LiveNumber value={criterion.meanScore} format={scoreFormat} /> / 4</dd>
                  </div>
                ))}
              </dl>
            ) : null}
            {release.sharedFindings ? (
              <div className="feedback-copy">
                <span>Panel findings</span>
                <p>{release.sharedFindings}</p>
              </div>
            ) : null}
            {release.sharedCommitments ? (
              <div className="feedback-copy">
                <span>Next checkpoint</span>
                <p>{release.sharedCommitments}</p>
              </div>
            ) : null}
          </article>
        ))}
      </div>
    </section>
  );
}

function formatTime(value: number) {
  return dateFormatter.format(value);
}

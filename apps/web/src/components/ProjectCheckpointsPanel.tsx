import { LiveNumber } from "./LiveNumber";
import { api } from "@code2create/backend/api";
import type { FunctionReturnType } from "convex/server";
import { useMutation, useQuery } from "convex/react";
import { useEffect, useState, type SubmitEvent } from "react";

import { eventSlug } from "../lib/config";
import { readableError } from "../lib/errors";
import { useMutationAttempt } from "../lib/operations";

type CheckpointState = FunctionReturnType<typeof api.projectCheckpoints.mine>;
type Checkpoint = CheckpointState["checkpoints"][number];

type DraftSnapshot = {
  version: number;
  updateText: string;
  followUpAnswer: string;
};

export function ProjectCheckpointsPanel({ timezone }: { timezone: string }) {
  const state = useQuery(api.projectCheckpoints.mine, { eventSlug });

  if (state === undefined) return null;
  if (!state.configured) return null;

  const actionableIndex = state.checkpoints.findIndex(
    (checkpoint) =>
      checkpoint.canEdit ||
      checkpoint.availability === "open" ||
      checkpoint.availability === "late",
  );
  const primaryIndex = actionableIndex >= 0 ? actionableIndex : 0;
  const primaryCheckpoint = state.checkpoints[primaryIndex];
  const otherCheckpoints = state.checkpoints.filter((_, index) => index !== primaryIndex);

  return (
    <section className="checkpoint-panel">
      <div className="section-heading">
        <div>
          <p className="eyebrow">During the event</p>
          <h2>Team updates</h2>
        </div>
      </div>
      <p className="muted">Share one update when it opens so your team has a clear build record.</p>
      <div className="checkpoint-list">
        {primaryCheckpoint ? (
          <CheckpointCard checkpoint={primaryCheckpoint} timezone={timezone} />
        ) : null}
      </div>
      {otherCheckpoints.length > 0 ? (
        <details className="checkpoint-other-updates">
          <summary>
            <span>Earlier and upcoming updates</span>
            <small><LiveNumber value={otherCheckpoints.length} /></small>
          </summary>
          <div className="checkpoint-list">
            {otherCheckpoints.map((checkpoint) => (
              <CheckpointCard
                checkpoint={checkpoint}
                key={checkpoint.checkpointKey}
                timezone={timezone}
              />
            ))}
          </div>
        </details>
      ) : null}
    </section>
  );
}

function CheckpointCard({ checkpoint, timezone }: { checkpoint: Checkpoint; timezone: string }) {
  const saveUpdate = useMutation(api.projectCheckpoints.saveUpdate);
  const saveFollowUp = useMutation(api.projectCheckpoints.saveFollowUp);
  const submit = useMutation(api.projectCheckpoints.submit);
  const [updateText, setUpdateText] = useState(checkpoint.draft?.updateText ?? "");
  const [followUpAnswer, setFollowUpAnswer] = useState(checkpoint.draft?.followUpAnswer ?? "");
  const [loadedDraft, setLoadedDraft] = useState<DraftSnapshot>(() => draftSnapshot(checkpoint));
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState<"update" | "follow_up" | "submit" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const updateAttempt =
    useMutationAttempt<FunctionReturnType<typeof api.projectCheckpoints.saveUpdate>>();
  const followUpAttempt =
    useMutationAttempt<FunctionReturnType<typeof api.projectCheckpoints.saveFollowUp>>();
  const submitAttempt =
    useMutationAttempt<FunctionReturnType<typeof api.projectCheckpoints.submit>>();
  const updatePending = updateAttempt.hasPending("checkpoint-update");
  const followUpPending = followUpAttempt.hasPending("checkpoint-follow-up");
  const submitPending = submitAttempt.hasPending("checkpoint-submit");
  const operationPending = updatePending || followUpPending || submitPending;
  const serverDraft = draftSnapshot(checkpoint);
  const updateDirty = updateText !== loadedDraft.updateText;
  const followUpDirty = followUpAnswer !== loadedDraft.followUpAnswer;
  const localDraftDirty = updateDirty || followUpDirty;
  const remoteDraftChanged = serverDraft.version > loadedDraft.version;
  const awaitingLiveDraft = serverDraft.version < loadedDraft.version;

  useEffect(() => {
    if (!remoteDraftChanged || localDraftDirty || busy !== null || operationPending) return;
    // oxlint-disable-next-line react/set-state-in-effect -- Adopt a newer collaborative draft only after proving the local editor is clean.
    setUpdateText(serverDraft.updateText);
    setFollowUpAnswer(serverDraft.followUpAnswer);
    setLoadedDraft(serverDraft);
    setReviewing(false);
  }, [busy, localDraftDirty, operationPending, remoteDraftChanged, serverDraft]);

  const loadTeamDraft = () => {
    setUpdateText(serverDraft.updateText);
    setFollowUpAnswer(serverDraft.followUpAnswer);
    setLoadedDraft(serverDraft);
    setReviewing(false);
    setError(null);
  };

  const keepLocalDraft = () => {
    setLoadedDraft(serverDraft);
    setReviewing(false);
    setError(null);
  };

  const saveFirstAnswer = async (event: SubmitEvent) => {
    event.preventDefault();
    const expectedVersion = loadedDraft.version;
    setBusy("update");
    setError(null);
    try {
      const result = await updateAttempt.run("checkpoint-update", () => {
        const args = {
          eventSlug,
          checkpointKey: checkpoint.checkpointKey,
          updateText,
          expectedDraftVersion: expectedVersion,
          clientOperationId: crypto.randomUUID(),
        };
        return () => saveUpdate(args);
      });
      const savedUpdateText = normalizeDraftText(updateText);
      const updateChanged = savedUpdateText !== loadedDraft.updateText;
      setUpdateText(savedUpdateText);
      setLoadedDraft({
        version: result.draftVersion,
        updateText: savedUpdateText,
        followUpAnswer: updateChanged ? "" : loadedDraft.followUpAnswer,
      });
      setReviewing(false);
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setBusy(null);
    }
  };

  const saveSecondAnswer = async (event: SubmitEvent) => {
    event.preventDefault();
    const draft = checkpoint.draft;
    if (!draft) return;
    setBusy("follow_up");
    setError(null);
    try {
      const result = await followUpAttempt.run("checkpoint-follow-up", () => {
        const args = {
          eventSlug,
          checkpointKey: checkpoint.checkpointKey,
          answer: followUpAnswer,
          expectedDraftVersion: loadedDraft.version,
          clientOperationId: crypto.randomUUID(),
        };
        return () => saveFollowUp(args);
      });
      const savedFollowUpAnswer = normalizeDraftText(followUpAnswer);
      setFollowUpAnswer(savedFollowUpAnswer);
      setLoadedDraft({
        ...loadedDraft,
        version: result.draftVersion,
        followUpAnswer: savedFollowUpAnswer,
      });
      setReviewing(false);
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setBusy(null);
    }
  };

  const submitUpdate = async () => {
    const draft = checkpoint.draft;
    if (!draft) return;
    setBusy("submit");
    setError(null);
    try {
      await submitAttempt.run("checkpoint-submit", () => {
        const args = {
          eventSlug,
          checkpointKey: checkpoint.checkpointKey,
          expectedDraftVersion: loadedDraft.version,
          clientOperationId: crypto.randomUUID(),
        };
        return () => submit(args);
      });
      setReviewing(false);
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setBusy(null);
    }
  };

  return (
    <article className="checkpoint-card">
      <header>
        <div>
          <h3>{checkpoint.displayName}</h3>
          {checkpoint.phaseName.toLocaleLowerCase("en") !==
          checkpoint.displayName.toLocaleLowerCase("en") ? (
            <p className="muted">{checkpoint.phaseName}</p>
          ) : null}
        </div>
        <span className={`checkpoint-state ${checkpoint.availability}`}>
          {availabilityLabel(checkpoint.availability)}
        </span>
      </header>
      <p className="fine-print">{checkpointWindow(checkpoint, timezone)}</p>

      {remoteDraftChanged && localDraftDirty ? (
        <div className="notice">
          <p>A teammate changed this update. Your unsaved text is still here.</p>
          <div className="button-row">
            <button
              className="secondary compact"
              disabled={busy !== null || operationPending}
              type="button"
              onClick={loadTeamDraft}
            >
              Use team version
            </button>
            <button
              className="primary compact"
              disabled={busy !== null || operationPending}
              type="button"
              onClick={keepLocalDraft}
            >
              Keep my draft
            </button>
          </div>
        </div>
      ) : null}

      {checkpoint.submission ? (
        <div className="checkpoint-submission">
          <p>{checkpoint.submission.updateText}</p>
          <p className="muted">{checkpoint.followUpQuestion}</p>
          <p>{checkpoint.submission.followUpAnswer}</p>
          <p className="fine-print">
            Submitted {formatTime(checkpoint.submission.submittedAt, timezone)} ·{" "}
            {submissionTimingLabel(checkpoint.submission.timing)}
          </p>
        </div>
      ) : checkpoint.canEdit ? (
        <>
          <form className="checkpoint-form" onSubmit={saveFirstAnswer}>
            <label className="field">
              <span>{checkpoint.prompt}</span>
              <textarea
                minLength={10}
                maxLength={4000}
                required
                disabled={
                  busy !== null || operationPending || remoteDraftChanged || awaitingLiveDraft
                }
                value={updateText}
                onChange={(event) => {
                  setUpdateText(event.currentTarget.value);
                  setReviewing(false);
                }}
              />
            </label>
            <button
              className="secondary"
              disabled={
                busy !== null ||
                followUpPending ||
                submitPending ||
                (!updatePending && (remoteDraftChanged || awaitingLiveDraft))
              }
              type="submit"
            >
              {busy === "update"
                ? "Saving…"
                : updatePending
                  ? "Confirm earlier save"
                  : checkpoint.draft?.updateText
                    ? "Save changes"
                    : "Continue"}
            </button>
          </form>

          {checkpoint.draft?.updateText && !updateDirty ? (
            <form className="checkpoint-form" onSubmit={saveSecondAnswer}>
              <label className="field">
                <span>{checkpoint.followUpQuestion}</span>
                <textarea
                  minLength={2}
                  maxLength={2000}
                  required
                  disabled={
                    busy !== null || operationPending || remoteDraftChanged || awaitingLiveDraft
                  }
                  value={followUpAnswer}
                  onChange={(event) => {
                    setFollowUpAnswer(event.currentTarget.value);
                    setReviewing(false);
                  }}
                />
              </label>
              <button
                className="secondary"
                disabled={
                  busy !== null ||
                  updatePending ||
                  submitPending ||
                  (!followUpPending && (remoteDraftChanged || awaitingLiveDraft))
                }
                type="submit"
              >
                {busy === "follow_up"
                  ? "Saving…"
                  : followUpPending
                    ? "Confirm earlier save"
                    : checkpoint.draft.followUpAnswer
                      ? "Save changes"
                      : "Save answer"}
              </button>
            </form>
          ) : null}

          {checkpoint.draft?.followUpAnswer && !updateDirty && !followUpDirty ? (
            reviewing ? (
              <div className="checkpoint-confirmation">
                <p>
                  This freezes the update above for the event record. It does not affect judging
                  scores.
                </p>
                <div className="offer-actions">
                  <button
                    className="secondary"
                    disabled={
                      busy !== null || operationPending || remoteDraftChanged || awaitingLiveDraft
                    }
                    type="button"
                    onClick={() => setReviewing(false)}
                  >
                    Keep editing
                  </button>
                  <button
                    className="primary"
                    disabled={
                      busy !== null ||
                      updatePending ||
                      followUpPending ||
                      (!submitPending && (remoteDraftChanged || awaitingLiveDraft))
                    }
                    type="button"
                    onClick={() => void submitUpdate()}
                  >
                    {busy === "submit"
                      ? "Submitting…"
                      : submitPending
                        ? "Confirm earlier submission"
                        : "Confirm submission"}
                  </button>
                </div>
              </div>
            ) : (
              <button
                className="primary"
                disabled={
                  busy !== null || operationPending || remoteDraftChanged || awaitingLiveDraft
                }
                type="button"
                onClick={() => setReviewing(true)}
              >
                Submit update
              </button>
            )
          ) : null}
        </>
      ) : (
        <p className="muted">{unavailableMessage(checkpoint)}</p>
      )}

      {error ? (
        <p className="notice error" role="alert">
          {error}
        </p>
      ) : null}
    </article>
  );
}

function availabilityLabel(availability: Checkpoint["availability"]) {
  if (availability === "awaiting_confirmation") return "Locked";
  if (availability === "upcoming") return "Upcoming";
  if (availability === "open") return "Open";
  if (availability === "late") return "Late";
  if (availability === "closed") return "Closed";
  return "Submitted";
}

function draftSnapshot(checkpoint: Checkpoint): DraftSnapshot {
  return {
    version: checkpoint.draft?.version ?? 0,
    updateText: checkpoint.draft?.updateText ?? "",
    followUpAnswer: checkpoint.draft?.followUpAnswer ?? "",
  };
}

function normalizeDraftText(value: string) {
  return value.trim().replace(/\r\n/g, "\n");
}

function submissionTimingLabel(timing: NonNullable<Checkpoint["submission"]>["timing"]) {
  return timing === "on_time" ? "On time" : "After the due time";
}

function checkpointWindow(checkpoint: Checkpoint, timezone: string) {
  if (checkpoint.availability === "upcoming") {
    return `Opens ${formatTime(checkpoint.opensAt, timezone)}`;
  }
  if (checkpoint.availability === "open") {
    return `Due ${formatTime(checkpoint.dueAt, timezone)}`;
  }
  if (checkpoint.availability === "late") {
    return `Due time passed. Open until ${formatTime(checkpoint.closesAt, timezone)}`;
  }
  return `Window ${formatTime(checkpoint.opensAt, timezone)}–${formatTime(checkpoint.closesAt, timezone)}`;
}

function unavailableMessage(checkpoint: Checkpoint) {
  if (
    !checkpoint.canEdit &&
    (checkpoint.availability === "open" || checkpoint.availability === "late")
  ) {
    return "This update is read-only for your account.";
  }
  if (checkpoint.availability === "awaiting_confirmation") {
    return "This opens after your team confirms its event place.";
  }
  if (checkpoint.availability === "upcoming") return "Nothing is needed yet.";
  return "The submission window has ended.";
}

function formatTime(timestamp: number, timezone: string) {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: timezone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp);
}

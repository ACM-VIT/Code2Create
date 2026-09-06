import { api } from "@code2create/backend/api";
import type { FunctionReturnType } from "convex/server";
import { useMutation, useQuery } from "convex/react";
import { useEffect, useState, type SubmitEvent } from "react";

import { eventSlug } from "../lib/config";
import { readableError } from "../lib/errors";
import { useMutationAttempt } from "../lib/operations";
import { dayTimeLabel } from "./dashboard/format";
import { PortalButton, PortalTextButton } from "./portal/PortalButton";
import { PortalError, PortalLabel, PortalTextarea } from "./portal/PortalField";

type CheckpointState = FunctionReturnType<typeof api.projectCheckpoints.mine>;
type Checkpoint = CheckpointState["checkpoints"][number];

type DraftSnapshot = {
  version: number;
  updateText: string;
  followUpAnswer: string;
};

/**
 * The team's checkpoints as a timeline: one section per update, the one
 * that needs writing first, each with its state and window on one line.
 * The forms and the collaborative-draft handling underneath are unchanged.
 */
export function ProjectCheckpointsPanel({ timezone }: { timezone: string }) {
  const state = useQuery(api.projectCheckpoints.mine, { eventSlug });

  if (state === undefined) {
    return (
      <p role="status" className="m-0 text-[13px] text-fg/55">
        Loading…
      </p>
    );
  }
  if (!state.configured || state.checkpoints.length === 0) {
    return <p className="m-0 text-[13px] text-fg/60">Nothing to update yet.</p>;
  }

  const actionableIndex = state.checkpoints.findIndex(
    (checkpoint) =>
      checkpoint.canEdit ||
      checkpoint.availability === "open" ||
      checkpoint.availability === "late",
  );
  const primaryIndex = actionableIndex >= 0 ? actionableIndex : 0;
  const ordered = [
    ...state.checkpoints.slice(primaryIndex, primaryIndex + 1),
    ...state.checkpoints.filter((_, index) => index !== primaryIndex),
  ];

  return (
    <ol className="m-0 flex list-none flex-col divide-y divide-petal-line p-0">
      {ordered.map((checkpoint) => (
        <CheckpointCard key={checkpoint.checkpointKey} checkpoint={checkpoint} timezone={timezone} />
      ))}
    </ol>
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

  const active = checkpoint.availability === "open" || checkpoint.availability === "late";
  const submitted = checkpoint.submission !== null && checkpoint.submission !== undefined;
  const frozen = busy !== null || operationPending || remoteDraftChanged || awaitingLiveDraft;

  return (
    <li className="py-5 first:pt-2 last:pb-2">
      <header className="flex items-baseline justify-between gap-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <span
            aria-hidden
            className={`size-2 shrink-0 rounded-full ${
              submitted
                ? "bg-rose-light"
                : active
                  ? "border border-rose-light"
                  : checkpoint.availability === "closed"
                    ? "bg-fg/25"
                    : "border border-rose/45"
            }`}
          />
          <h2 className="m-0 truncate font-display text-[19px] font-normal text-fg">
            {checkpoint.displayName}
          </h2>
        </div>
        <span
          className={`shrink-0 text-[11px] ${active && !submitted ? "text-rose-light" : "text-fg/50"}`}
        >
          {availabilityLabel(checkpoint)}
        </span>
      </header>
      <p className="m-0 mt-1 pl-[18px] text-[12px] text-fg/50">{checkpointWindow(checkpoint, timezone)}</p>

      <div className="mt-4 flex flex-col gap-4 pl-[18px]">
        {remoteDraftChanged && localDraftDirty ? (
          <p className="m-0 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[12.5px] text-fg/70">
            <span>A teammate changed this update; your unsaved text is still here.</span>
            <PortalTextButton
              type="button"
              disabled={busy !== null || operationPending}
              onClick={loadTeamDraft}
              className="text-rose-light!"
            >
              use the team’s version
            </PortalTextButton>
            <PortalTextButton
              type="button"
              disabled={busy !== null || operationPending}
              onClick={keepLocalDraft}
              className="text-rose-light!"
            >
              keep mine
            </PortalTextButton>
          </p>
        ) : null}

        {checkpoint.submission ? (
          <div className="flex flex-col gap-3">
            <p className="m-0 text-[14px] leading-relaxed whitespace-pre-wrap text-fg/90">
              {checkpoint.submission.updateText}
            </p>
            <div>
              <PortalLabel>{checkpoint.followUpQuestion}</PortalLabel>
              <p className="m-0 text-[13.5px] leading-relaxed whitespace-pre-wrap text-fg/80">
                {checkpoint.submission.followUpAnswer}
              </p>
            </div>
          </div>
        ) : checkpoint.canEdit ? (
          <>
            <form className="flex flex-col gap-3" onSubmit={saveFirstAnswer}>
              <label className="block">
                <PortalLabel>{checkpoint.prompt}</PortalLabel>
                <PortalTextarea
                  rows={5}
                  minLength={10}
                  maxLength={4000}
                  required
                  disabled={frozen}
                  value={updateText}
                  onChange={(event) => {
                    setUpdateText(event.currentTarget.value);
                    setReviewing(false);
                  }}
                />
              </label>
              <div className="flex justify-end">
                <PortalButton
                  size="xs"
                  type="submit"
                  disabled={
                    busy !== null ||
                    followUpPending ||
                    submitPending ||
                    (!updatePending && (remoteDraftChanged || awaitingLiveDraft))
                  }
                >
                  {busy === "update"
                    ? "Saving…"
                    : updatePending
                      ? "Confirm earlier save"
                      : checkpoint.draft?.updateText
                        ? "Save changes"
                        : "Continue"}
                </PortalButton>
              </div>
            </form>

            {checkpoint.draft?.updateText && !updateDirty ? (
              <form className="flex flex-col gap-3" onSubmit={saveSecondAnswer}>
                <label className="block">
                  <PortalLabel>{checkpoint.followUpQuestion}</PortalLabel>
                  <PortalTextarea
                    rows={3}
                    minLength={2}
                    maxLength={2000}
                    required
                    disabled={frozen}
                    value={followUpAnswer}
                    onChange={(event) => {
                      setFollowUpAnswer(event.currentTarget.value);
                      setReviewing(false);
                    }}
                  />
                </label>
                <div className="flex justify-end">
                  <PortalButton
                    size="xs"
                    type="submit"
                    disabled={
                      busy !== null ||
                      updatePending ||
                      submitPending ||
                      (!followUpPending && (remoteDraftChanged || awaitingLiveDraft))
                    }
                  >
                    {busy === "follow_up"
                      ? "Saving…"
                      : followUpPending
                        ? "Confirm earlier save"
                        : checkpoint.draft.followUpAnswer
                          ? "Save changes"
                          : "Save answer"}
                  </PortalButton>
                </div>
              </form>
            ) : null}

            {checkpoint.draft?.followUpAnswer && !updateDirty && !followUpDirty ? (
              reviewing ? (
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="m-0 text-[12.5px] text-fg/60">
                    This freezes the update for the event record. It doesn’t affect judging.
                  </p>
                  <div className="flex gap-2">
                    <PortalButton
                      size="xs"
                      type="button"
                      disabled={frozen}
                      onClick={() => setReviewing(false)}
                    >
                      Keep editing
                    </PortalButton>
                    <PortalButton
                      size="xs"
                      variant="solid"
                      type="button"
                      disabled={
                        busy !== null ||
                        updatePending ||
                        followUpPending ||
                        (!submitPending && (remoteDraftChanged || awaitingLiveDraft))
                      }
                      onClick={() => void submitUpdate()}
                    >
                      {busy === "submit"
                        ? "Submitting…"
                        : submitPending
                          ? "Confirm earlier submission"
                          : "Confirm submission"}
                    </PortalButton>
                  </div>
                </div>
              ) : (
                <div className="flex justify-end">
                  <PortalButton
                    size="xs"
                    variant="solid"
                    type="button"
                    disabled={frozen}
                    onClick={() => setReviewing(true)}
                  >
                    Submit update
                  </PortalButton>
                </div>
              )
            ) : null}
          </>
        ) : (
          <p className="m-0 text-[13px] text-fg/55">{unavailableMessage(checkpoint)}</p>
        )}

        <PortalError message={error} />
      </div>
    </li>
  );
}

function availabilityLabel(checkpoint: Checkpoint) {
  if (checkpoint.submission) return "submitted";
  switch (checkpoint.availability) {
    case "awaiting_confirmation":
      return "locked";
    case "upcoming":
      return "upcoming";
    case "open":
      return "open";
    case "late":
      return "late";
    case "closed":
      return "closed";
    default:
      return "submitted";
  }
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

function checkpointWindow(checkpoint: Checkpoint, timezone: string) {
  if (checkpoint.submission) {
    return `submitted ${dayTimeLabel(checkpoint.submission.submittedAt, timezone)} · ${
      checkpoint.submission.timing === "on_time" ? "on time" : "after the due time"
    }`;
  }
  switch (checkpoint.availability) {
    case "upcoming":
    case "awaiting_confirmation":
      return `opens ${dayTimeLabel(checkpoint.opensAt, timezone)}`;
    case "open":
      return `due ${dayTimeLabel(checkpoint.dueAt, timezone)}`;
    case "late":
      return `due time passed · open until ${dayTimeLabel(checkpoint.closesAt, timezone)}`;
    default:
      return `closed ${dayTimeLabel(checkpoint.closesAt, timezone)}`;
  }
}

function unavailableMessage(checkpoint: Checkpoint) {
  if (
    !checkpoint.canEdit &&
    (checkpoint.availability === "open" || checkpoint.availability === "late")
  ) {
    return "Your team lead writes this one.";
  }
  if (checkpoint.availability === "awaiting_confirmation") {
    return "Opens once your team confirms its place.";
  }
  if (checkpoint.availability === "upcoming") return "Nothing needed yet.";
  return "The window has closed.";
}

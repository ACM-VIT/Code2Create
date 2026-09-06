import { reviewerFitsSeat } from "@code2create/domain";
import { api } from "@code2create/backend/api";
import type { FunctionReturnType } from "convex/server";
import { useMutation } from "convex/react";
import { useState } from "react";
import { eventSlug } from "../lib/config";
import { readableError } from "../lib/errors";
import { useMutationAttempt } from "../lib/operations";

type Status = FunctionReturnType<typeof api.reviewSubstitutions.roundStatus>;
type SubstitutionPanel = Status["panels"][number];
type Reserve = Status["reserves"][number];

export function ReviewPanelMembership({
  panel,
  reserves,
  panels,
  allowSeniorLeadFallback,
}: {
  panel: SubstitutionPanel;
  reserves: Reserve[];
  panels: SubstitutionPanel[];
  allowSeniorLeadFallback: boolean;
}) {
  const swapPanelMember = useMutation(
    api.reviewPanelMembership.swapPanelMember,
  );
  const [open, setOpen] = useState(false);
  const [leavingPersonId, setLeavingPersonId] = useState("");
  const [joiningPersonId, setJoiningPersonId] = useState("");
  const [reason, setReason] = useState("");
  const [search, setSearch] = useState("");
  const [reasonChoice, setReasonChoice] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const operationAttempt =
    useMutationAttempt<
      FunctionReturnType<typeof api.reviewPanelMembership.swapPanelMember>
    >();
  const operationSlot = `review-panel-membership:${panel.panelId}`;
  const operationPending = operationAttempt.hasPending(operationSlot);

  if (!panel.canSwapMembers)
    return (
      <p className="m-0 text-sm text-ink-2">{panel.membershipBlockedReason}</p>
    );

  const leaving = panel.activeMembers.find(
    (member) => member.personId === leavingPersonId,
  );
  const seat = leaving?.seat ?? panel.vacancy?.seat;
  const fits = (
    profile: Reserve["profile"],
    target: NonNullable<typeof seat>,
  ) =>
    Boolean(
      profile?.canJoin &&
      reviewerFitsSeat(
        profile.seniority,
        target.seniority,
        allowSeniorLeadFallback,
      ) &&
      target.criterionKeys.every((key) => profile.criterionKeys.includes(key)),
    );

  const candidates = [
    ...reserves
      .filter((r) => r.status === "available" && seat && fits(r.profile, seat))
      .map((r) => ({
        personId: r.personId,
        displayName: r.displayName,
        source: null,
        seniority: r.profile?.seniority,
      })),
    ...panels
      .filter((p) => p.panelId !== panel.panelId && p.canSwapMembers)
      .flatMap((p) =>
        p.activeMembers
          .filter(
            (m) =>
              seat &&
              fits(m.profile, seat) &&
              (leaving ? fits(leaving.profile, m.seat) : !m.isCoordinator),
          )
          .map((m) => ({
            personId: m.personId,
            displayName: m.displayName,
            source: p,
            seniority: m.profile?.seniority,
          })),
      ),
  ];
  const joining = candidates.find(
    (reserve) => reserve.personId === joiningPersonId,
  );
  const invalidSeat =
    (!leaving && !panel.vacancy) ||
    (!joining && joiningPersonId !== "remove") ||
    (Boolean(leaving?.isCoordinator) && !joining);

  const changed = () => {
    setError(null);
  };

  const submit = async () => {
    if (
      busy ||
      (reasonChoice === "other" ? reason : reasonChoice).trim().length < 5 ||
      invalidSeat ||
      (!leaving && !joining)
    )
      return;
    setBusy(true);
    setError(null);
    try {
      await operationAttempt.run(operationSlot, () => {
        const args = {
          eventSlug,
          panelId: panel.panelId,
          ...(leaving ? { leavingPersonId: leaving.personId } : {}),
          ...(joining ? { joiningPersonId: joining.personId } : {}),
          expectedPanelVersion: panel.panelVersion,
          ...(joining?.source
            ? {
                sourcePanel: {
                  panelId: joining.source.panelId,
                  expectedVersion: joining.source.panelVersion,
                },
              }
            : {}),
          reason: reasonChoice === "other" ? reason : reasonChoice,
          clientOperationId: crypto.randomUUID(),
        };
        return () => swapPanelMember(args);
      });
      setOpen(false);
      setLeavingPersonId("");
      setJoiningPersonId("");
      setReason("");
      setReasonChoice("");
      setSearch("");
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button
        className="text-button"
        type="button"
        onClick={() => setOpen(true)}
      >
        Edit reviewers
      </button>
    );
  }
  return (
    <div className="grid w-full gap-4 rounded-xl border border-line p-4">
      <label className="field compact-select">
        <span>Current seat</span>
        <select
          disabled={operationPending}
          value={leavingPersonId}
          onChange={(event) => {
            setLeavingPersonId(event.target.value);
            setJoiningPersonId("");
            setSearch("");
            changed();
          }}
        >
          <option value="">
            {panel.vacancy
              ? `Fill ${panel.vacancy.displayName}’s vacant seat`
              : "Choose a reviewer"}
          </option>
          {panel.activeMembers.map((member) => (
            <option key={member.personId} value={member.personId}>
              {member.displayName}
              {member.isCoordinator ? " · runs this panel" : ""}
            </option>
          ))}
        </select>
      </label>
      {seat ? (
        <label className="field">
          <span>Find a replacement</span>
          <input
            value={search}
            disabled={operationPending}
            placeholder="Name or panel"
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
      ) : null}
      <label className="field compact-select">
        <span>Replace with</span>
        <select
          disabled={operationPending || !seat}
          value={joiningPersonId}
          onChange={(event) => {
            setJoiningPersonId(event.target.value);
            changed();
          }}
        >
          <option value="">Choose a replacement</option>
          {leaving && !leaving.isCoordinator ? (
            <option value="remove">Return current reviewer to reserves</option>
          ) : null}
          {candidates
            .filter(
              (r) =>
                r.personId === joiningPersonId ||
                `${r.displayName} ${r.source?.name ?? "Reserve"}`
                  .toLowerCase()
                  .includes(search.toLowerCase()),
            )
            .map((reserve) => (
              <option key={reserve.personId} value={reserve.personId}>
                {reserve.displayName} · {reserve.seniority?.toUpperCase()} ·{" "}
                {reserve.source ? reserve.source.name : "Reserve"}
              </option>
            ))}
        </select>
      </label>
      {seat && candidates.length === 0 ? (
        <p className="muted">
          No matching reviewer is ready. Check seniority, scoring skills,
          training and confirmed hours in People & planning.
        </p>
      ) : null}
      {joining?.source ? (
        <p className="m-0 text-sm text-ink-2">
          {joining.displayName} moves here from {joining.source.name}.
          {leaving
            ? ` ${leaving.displayName} takes their seat there.`
            : " Their old seat becomes vacant."}
        </p>
      ) : leaving && (joining || joiningPersonId === "remove") ? (
        <p className="m-0 text-sm text-ink-2">
          {leaving.displayName} returns to this round’s reserve pool.
        </p>
      ) : null}
      {leaving?.isCoordinator ? (
        <p className="muted">
          Choose a replacement to take over running this panel.
        </p>
      ) : null}
      <label className="field">
        <span>Reason</span>
        <select
          disabled={operationPending}
          value={reasonChoice}
          onChange={(event) => {
            setReasonChoice(event.target.value);
            changed();
          }}
        >
          <option value="">Choose a reason</option>
          <option value="Reviewer availability changed">
            Availability changed
          </option>
          <option value="Better project and reviewer skill match">
            Better skills match
          </option>
          <option value="Balance reviewer workload and opportunities">
            Balance workload / give someone a turn
          </option>
          <option value="other">Other reason</option>
        </select>
      </label>
      {reasonChoice === "other" ? (
        <label className="field">
          <span>Details</span>
          <input
            value={reason}
            maxLength={500}
            disabled={operationPending}
            onChange={(event) => {
              setReason(event.target.value);
              changed();
            }}
          />
        </label>
      ) : null}
      <div className="button-row">
        <button
          className="primary"
          disabled={
            busy ||
            (reasonChoice === "other" ? reason : reasonChoice).trim().length <
              5 ||
            invalidSeat ||
            (!leaving && !joining)
          }
          type="button"
          onClick={() => void submit()}
        >
          {busy
            ? "Saving…"
            : operationPending
              ? "Confirm earlier panel change"
              : joining?.source && leaving
                ? "Swap reviewers"
                : joining && leaving
                  ? "Replace reviewer"
                  : joining
                    ? "Move reviewer here"
                    : joiningPersonId === "remove"
                      ? "Return to reserves"
                      : "Replace reviewer"}
        </button>
        <button
          className="secondary compact-link"
          disabled={busy || operationPending}
          type="button"
          onClick={() => setOpen(false)}
        >
          Cancel
        </button>
      </div>
      {error ? (
        <p className="notice error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

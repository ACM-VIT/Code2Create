import { api } from "@code2create/backend/api";
import { reviewRoundStatusLabels } from "@code2create/domain";
import type { FunctionReturnType } from "convex/server";
import { useMutation, useQuery } from "convex/react";
import { useRef, useState, type SubmitEvent } from "react";
import { Link } from "react-router-dom";
import { ReviewerVenuePanel } from "../components/ReviewerVenuePanel";

import { eventSlug } from "../lib/config";
import { readableError } from "../lib/errors";
import { useMutationAttempt } from "../lib/operations";

type Candidate = FunctionReturnType<typeof api.reviewConfiguration.candidates>[number];
type TrainingStatus = "pending" | "complete" | "blocked";
type ProfileStatus = "active" | "inactive";
type PersonId = Candidate["personId"];
type Anchors = {
  zero: string;
  one: string;
  two: string;
  three: string;
  four: string;
};
type CriterionDraft = {
  id: string;
  stableKey: string;
  label: string;
  question: string;
  guidance: string;
  weight: string;
  anchors: Anchors;
};
type MemberDraft = {
  id: string;
  personId: string;
  criterionIds: string[];
  isCoordinator: boolean;
};
type PanelDraft = {
  id: string;
  stableKey: string;
  name: string;
  members: MemberDraft[];
};
type AvailabilityWindowDraft = {
  id: string;
  startsAt: string;
  endsAt: string;
};
type ReviewerView = "needs_setup" | "ready" | "all";
type RoundDraft = {
  stableKey: string;
  name: string;
  sequence: string;
  clockInOpensAt: string;
  reviewerReportAt: string;
  startsAt: string;
  endsAt: string;
  noShowGraceSeconds: string;
  correctionRequestsCloseAt: string;
  reviewDurationMinutes: string;
  ordinaryExtensionMinutes: string;
  maximumOrdinaryExtensions: string;
  missedCallGraceSeconds: string;
  requiredCallAttempts: string;
  substituteResponseSeconds: string;
  missedReentryPolicy: "preserve_queue_time" | "queue_end" | "manual";
  requiredPanelSize: string;
  minimumScorersPerCriterion: string;
  minimumPresentParticipants: string;
  minimumReviewerBuild: string;
  requiresSharedCommitments: boolean;
  requiresCamera: boolean;
  requiresNotifications: boolean;
};

const initialCriteria: CriterionDraft[] = [
  {
    id: "criterion-problem",
    stableKey: "problem_value",
    label: "Problem and user value",
    question: "Is the team solving a clear problem for a specific user?",
    guidance:
      "Look for a concrete need, intended user, and a useful outcome rather than presentation polish.",
    weight: "25",
    anchors: {
      zero: "No clear problem or user.",
      one: "A broad problem is named, but the user or value is unclear.",
      two: "The problem and intended user are understandable.",
      three: "The team explains the user need and important constraints clearly.",
      four: "The team shows a sharp, well-supported understanding of the user and value.",
    },
  },
  {
    id: "criterion-progress",
    stableKey: "working_progress",
    label: "Working progress",
    question: "What has the team made and demonstrated during this hack?",
    guidance:
      "Judge the current working slice and verified progress. Do not reward a polished pitch in place of a product.",
    weight: "25",
    anchors: {
      zero: "No working progress can be demonstrated.",
      one: "Only isolated setup or static mock material is shown.",
      two: "A small end-to-end path or meaningful subsystem works.",
      three: "The core path works with only bounded gaps.",
      four: "A coherent product works end to end and handles its central use case well.",
    },
  },
  {
    id: "criterion-technical",
    stableKey: "technical_execution",
    label: "Technical execution",
    question: "Do the implementation choices fit the problem and hold up under inspection?",
    guidance:
      "Use the fixed repository and Figma evidence. Consider correctness, integration, data flow, and practical trade-offs.",
    weight: "30",
    anchors: {
      zero: "The claimed implementation cannot be explained or inspected.",
      one: "Major technical claims are disconnected or largely unimplemented.",
      two: "The implementation is plausible and the main choices are understood.",
      three: "The system is thoughtfully built with sound, inspectable trade-offs.",
      four: "The implementation is unusually strong, coherent, and well matched to the problem.",
    },
  },
  {
    id: "criterion-decisions",
    stableKey: "decisions_next_step",
    label: "Decisions and next step",
    question: "Has the team learned, made deliberate choices, and identified the right next step?",
    guidance:
      "Look for honest reasoning and a concrete next checkpoint, not certainty or inflated claims.",
    weight: "20",
    anchors: {
      zero: "The team cannot explain its decisions or next step.",
      one: "Decisions are mostly accidental and the next step is vague.",
      two: "The team can explain key choices and a reasonable next step.",
      three: "Learning clearly changed the product and the next step is specific.",
      four: "The team demonstrates exceptional judgment, reflection, and prioritisation.",
    },
  },
];

export function ReviewSetup({
  canPublish,
  canReadConfiguration,
  canReadProfiles,
  canReadRounds,
}: {
  canPublish: boolean;
  canReadConfiguration: boolean;
  canReadProfiles: boolean;
  canReadRounds: boolean;
}) {
  const configuration = useQuery(
    api.reviewConfiguration.current,
    canReadConfiguration ? { eventSlug } : "skip",
  );
  const candidates = useQuery(
    api.reviewConfiguration.candidates,
    canReadProfiles ? { eventSlug } : "skip",
  );

  if (
    (canReadConfiguration && configuration === undefined) ||
    (canReadProfiles && candidates === undefined)
  ) {
    return <p className="muted">Loading review setup…</p>;
  }

  const nextSequence = (configuration?.rounds.at(-1)?.sequence ?? 0) + 1;
  const reviewerCandidates = candidates ?? [];

  return (
    <section className="review-shell setup-shell">
      {canReadRounds ? (
        <Link className="back-link" to="/reviews">
          ← Judging
        </Link>
      ) : null}
      <header className="page-heading">
        <div>
          <p className="eyebrow">Judging</p>
          <h1>Judging setup</h1>
          <p className="muted">
            Prepare reviewers, timing, the rubric, and panels for each judging round.
          </p>
        </div>
      </header>

      {configuration ? (
        <section className="setup-section">
          <h2>Published rounds</h2>
          <p className="muted section-note">
            A round is published with its panels already built. After that, panel membership only
            changes through a substitute on the board.
          </p>
          <div className="published-rounds">
            {configuration.rounds.map((round) => (
              <div className="published-round-row" key={round.id}>
                <div>
                  <strong>{round.name}</strong>
                  <span>
                    {reviewRoundStatusLabels[round.status]} · {round.panelCount} panels ·{" "}
                    {round.reviewerCount} reviewers · {round.reserveCount} reserves
                  </span>
                  <span>
                    Clock-in {formatMoment(round.clockInOpensAt)} · report{" "}
                    {formatMoment(round.reviewerReportAt)} · no-show after{" "}
                    {round.noShowGraceSeconds}s
                  </span>
                  <span>
                    Score-correction requests close {formatMoment(round.correctionRequestsCloseAt)}
                  </span>
                </div>
                {round.canReadBoard ? (
                  <Link className="row-action" to={`/reviews/${round.id}`}>
                    See its panels
                  </Link>
                ) : null}
              </div>
            ))}
            {configuration.rounds.length === 0 ? (
              <p className="muted">No round has been published.</p>
            ) : null}
          </div>
        </section>
      ) : null}

      {canReadProfiles ? <ReviewerProfiles candidates={reviewerCandidates} /> : null}
      <ReviewerVenuePanel
        canReadConfiguration={canReadConfiguration}
        canReadProfiles={canReadProfiles}
        canPublish={canPublish}
      />

      {canReadConfiguration && canReadProfiles ? (
        <details className="workspace-disclosure review-round-builder">
          <summary>
            <span>
              <strong>New judging round</strong>
              <small>
                Set timing, rubric, panels, reserves, and publish when everything is ready.
              </small>
            </span>
            <span className="workspace-disclosure-toggle" aria-hidden="true" />
          </summary>
          <div className="workspace-disclosure-body">
            <RoundPublisher
              canPublish={canPublish}
              candidates={reviewerCandidates}
              nextSequence={nextSequence}
            />
          </div>
        </details>
      ) : (
        <p className="notice">
          Building panels needs access to both judging rules and reviewer profiles.
        </p>
      )}
    </section>
  );
}

function ReviewerProfiles({ candidates }: { candidates: Candidate[] }) {
  const [view, setView] = useState<ReviewerView>("needs_setup");
  const ready = candidates.filter(reviewerIsReady).length;
  const outstanding = candidates.length - ready;
  const ordered = [...candidates].sort((left, right) => {
    const leftReady = left.profile?.trainingStatus === "complete";
    const rightReady = right.profile?.trainingStatus === "complete";
    if (leftReady !== rightReady) return leftReady ? 1 : -1;
    return left.displayName.localeCompare(right.displayName);
  });
  const visible = ordered.filter((candidate) => {
    if (view === "ready") return reviewerIsReady(candidate);
    if (view === "needs_setup") return !reviewerIsReady(candidate);
    return true;
  });

  return (
    <section className="setup-section">
      <h2>Reviewers</h2>
      <p className="muted">
        {outstanding === 0
          ? `All ${candidates.length} reviewers are ready to judge.`
          : `${outstanding} of ${candidates.length} reviewers still need setting up before they can judge.`}
      </p>
      <div
        className="configuration-tabs reviewer-view-tabs"
        role="group"
        aria-label="Reviewer setup view"
      >
        <button
          aria-pressed={view === "needs_setup"}
          className={view === "needs_setup" ? "active" : ""}
          type="button"
          onClick={() => setView("needs_setup")}
        >
          Needs setup · {outstanding}
        </button>
        <button
          aria-pressed={view === "ready"}
          className={view === "ready" ? "active" : ""}
          type="button"
          onClick={() => setView("ready")}
        >
          Ready · {ready}
        </button>
        <button
          aria-pressed={view === "all"}
          className={view === "all" ? "active" : ""}
          type="button"
          onClick={() => setView("all")}
        >
          All · {candidates.length}
        </button>
      </div>
      <div className="reviewer-profile-list">
        {visible.map((candidate) => (
          <ReviewerProfileRow
            candidate={candidate}
            canManage={candidate.canManage}
            key={candidate.personId}
          />
        ))}
        {visible.length === 0 && candidates.length > 0 ? (
          <p className="list-empty">No reviewers match this view.</p>
        ) : null}
      </div>
      {candidates.length === 0 ? (
        <p className="notice">Add reviewers to the event team before setting up their training.</p>
      ) : null}
    </section>
  );
}

function reviewerIsReady(candidate: Candidate) {
  return (
    candidate.profile?.status === "active" &&
    candidate.profile.trainingStatus === "complete" &&
    candidate.profile.availabilityWindows.length > 0
  );
}

function ReviewerProfileRow({
  candidate,
  canManage,
}: {
  candidate: Candidate;
  canManage: boolean;
}) {
  const saveProfile = useMutation(api.reviewConfiguration.saveProfile);
  const nextAvailabilityIdRef = useRef(candidate.profile?.availabilityWindows.length ?? 0);
  const [editing, setEditing] = useState(false);
  const [contactPhone, setContactPhone] = useState(candidate.profile?.contactPhone ?? "");
  const [technicalDomains, setTechnicalDomains] = useState(
    candidate.profile?.technicalDomains.join(", ") ?? "",
  );
  const [productDomains, setProductDomains] = useState(
    candidate.profile?.productDomains.join(", ") ?? "",
  );
  const [languages, setLanguages] = useState(candidate.profile?.languages.join(", ") ?? "");
  const [criterionKeys, setCriterionKeys] = useState(
    candidate.profile?.criterionKeys.join(", ") ?? "",
  );
  const [availabilityWindows, setAvailabilityWindows] = useState<AvailabilityWindowDraft[]>(
    () =>
      candidate.profile?.availabilityWindows.map((window, index) => ({
        id: `availability-${index}`,
        startsAt: localDateTime(window.startsAt),
        endsAt: localDateTime(window.endsAt),
      })) ?? [],
  );
  const [trainingStatus, setTrainingStatus] = useState<TrainingStatus>(
    candidate.profile?.trainingStatus ?? "pending",
  );
  const [status, setStatus] = useState<ProfileStatus>(candidate.profile?.status ?? "active");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const operationAttempt =
    useMutationAttempt<FunctionReturnType<typeof api.reviewConfiguration.saveProfile>>();
  const operationSlot = `reviewer-profile:${candidate.personId}`;
  const operationPending = operationAttempt.hasPending(operationSlot);
  const selectedCriterionKeys = new Set(commaList(criterionKeys));

  const changed = () => {
    setError(null);
  };

  const toggleCriterionKey = (stableKey: string, selected: boolean) => {
    const next = new Set(commaList(criterionKeys));
    if (selected) next.add(stableKey);
    else next.delete(stableKey);
    setCriterionKeys([...next].join(", "));
    changed();
  };

  const addAvailabilityWindow = () => {
    const id = `availability-${nextAvailabilityIdRef.current}`;
    nextAvailabilityIdRef.current += 1;
    setAvailabilityWindows((current) => [...current, { id, startsAt: "", endsAt: "" }]);
    changed();
  };

  const updateAvailabilityWindow = (
    id: string,
    update: (current: AvailabilityWindowDraft) => AvailabilityWindowDraft,
  ) => {
    setAvailabilityWindows((current) =>
      current.map((window) => (window.id === id ? update(window) : window)),
    );
    changed();
  };

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await operationAttempt.run(operationSlot, () => {
        const args = {
          eventSlug,
          personId: candidate.personId,
          ...(contactPhone.trim() ? { contactPhone: contactPhone.trim() } : {}),
          technicalDomains: commaList(technicalDomains),
          productDomains: commaList(productDomains),
          languages: commaList(languages),
          criterionKeys: commaList(criterionKeys),
          availabilityWindows: availabilityWindows.map((window, index) => ({
            startsAt: timestamp(window.startsAt, `Availability window ${index + 1} start`),
            endsAt: timestamp(window.endsAt, `Availability window ${index + 1} end`),
          })),
          trainingStatus,
          status,
          expectedVersion: candidate.profile?.version ?? 0,
          reason,
          clientOperationId: crypto.randomUUID(),
        };
        return () => saveProfile(args);
      });
      setEditing(false);
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="reviewer-profile-row">
      <div className="reviewer-profile-heading">
        <div>
          <strong>{candidate.displayName}</strong>
          <span>{candidate.email}</span>
        </div>
        <div className="reviewer-profile-state">
          <span>
            {trainingStatusName(candidate.profile?.trainingStatus)} ·{" "}
            {candidate.profile?.availabilityWindows.length ?? 0} availability{" "}
            {(candidate.profile?.availabilityWindows.length ?? 0) === 1 ? "window" : "windows"}
          </span>
          {canManage ? (
            <button
              className="text-button"
              disabled={operationPending}
              type="button"
              onClick={() => setEditing((current) => !current)}
            >
              {editing ? "Close" : candidate.profile ? "Edit" : "Set up"}
            </button>
          ) : null}
        </div>
      </div>
      {editing ? (
        <form className="reviewer-profile-form" onSubmit={submit}>
          <fieldset disabled={operationPending} style={{ display: "contents" }}>
            <label className="field">
              <span>
                Phone <small>For urgent paging</small>
              </span>
              <input
                inputMode="tel"
                placeholder="+919876543210"
                value={contactPhone}
                onChange={(event) => {
                  setContactPhone(event.target.value);
                  changed();
                }}
              />
            </label>
            <label className="field">
              <span>
                Technical domains <small>Comma separated</small>
              </span>
              <input
                value={technicalDomains}
                onChange={(event) => {
                  setTechnicalDomains(event.target.value);
                  changed();
                }}
              />
            </label>
            <label className="field">
              <span>
                Product domains <small>Comma separated</small>
              </span>
              <input
                value={productDomains}
                onChange={(event) => {
                  setProductDomains(event.target.value);
                  changed();
                }}
              />
            </label>
            <label className="field">
              <span>
                Languages <small>Comma separated</small>
              </span>
              <input
                value={languages}
                onChange={(event) => {
                  setLanguages(event.target.value);
                  changed();
                }}
              />
            </label>
            <fieldset className="reviewer-qualification-field">
              <legend>Can judge</legend>
              <div className="criterion-assignment-list">
                {initialCriteria.map((criterion) => (
                  <label className="check-filter" key={criterion.stableKey}>
                    <input
                      checked={selectedCriterionKeys.has(criterion.stableKey)}
                      type="checkbox"
                      onChange={(event) =>
                        toggleCriterionKey(criterion.stableKey, event.target.checked)
                      }
                    />
                    {criterion.label}
                  </label>
                ))}
              </div>
              <details className="configuration-advanced">
                <summary>Other rubric criteria</summary>
                <label className="field">
                  <span>
                    All criteria <small>Comma separated</small>
                  </span>
                  <input
                    value={criterionKeys}
                    onChange={(event) => {
                      setCriterionKeys(event.target.value);
                      changed();
                    }}
                  />
                </label>
              </details>
            </fieldset>
            <fieldset className="reviewer-qualification-field">
              <legend>Available for judging</legend>
              <p className="muted">
                Every reviewer and reserve must be available for the whole staffing window.
              </p>
              <div className="criterion-editors">
                {availabilityWindows.map((window, index) => (
                  <div className="form-grid" key={window.id}>
                    <label className="field">
                      <span>
                        Window {index + 1} starts <small>Event local time</small>
                      </span>
                      <input
                        type="datetime-local"
                        value={window.startsAt}
                        onChange={(event) => {
                          updateAvailabilityWindow(window.id, (current) => ({
                            ...current,
                            startsAt: event.target.value,
                          }));
                        }}
                      />
                    </label>
                    <label className="field">
                      <span>
                        Window {index + 1} ends <small>Event local time</small>
                      </span>
                      <input
                        type="datetime-local"
                        value={window.endsAt}
                        onChange={(event) => {
                          updateAvailabilityWindow(window.id, (current) => ({
                            ...current,
                            endsAt: event.target.value,
                          }));
                        }}
                      />
                    </label>
                    <button
                      className="text-button"
                      type="button"
                      onClick={() => {
                        setAvailabilityWindows((current) =>
                          current.filter((item) => item.id !== window.id),
                        );
                        changed();
                      }}
                    >
                      Remove window
                    </button>
                  </div>
                ))}
              </div>
              <button className="secondary" type="button" onClick={addAvailabilityWindow}>
                Add availability window
              </button>
            </fieldset>
            <label className="field">
              <span>Training</span>
              <select
                value={trainingStatus}
                onChange={(event) => {
                  setTrainingStatus(trainingStatusValue(event.target.value, trainingStatus));
                  changed();
                }}
              >
                <option value="pending">Pending</option>
                <option value="complete">Complete</option>
                <option value="blocked">Blocked</option>
              </select>
            </label>
            <label className="field">
              <span>Status</span>
              <select
                value={status}
                onChange={(event) => {
                  setStatus(event.target.value === "inactive" ? "inactive" : "active");
                  changed();
                }}
              >
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </select>
            </label>
            <label className="field full-field">
              <span>Reason</span>
              <textarea
                required
                value={reason}
                onChange={(event) => {
                  setReason(event.target.value);
                  changed();
                }}
              />
            </label>
          </fieldset>
          <button className="primary" type="submit" disabled={busy || reason.trim().length < 5}>
            {busy
              ? "Saving…"
              : operationPending
                ? "Confirm earlier profile"
                : "Save reviewer profile"}
          </button>
          {error ? (
            <p className="notice error" role="alert">
              {error}
            </p>
          ) : null}
        </form>
      ) : null}
    </article>
  );
}

function RoundPublisher({
  canPublish,
  candidates,
  nextSequence,
}: {
  canPublish: boolean;
  candidates: Candidate[];
  nextSequence: number;
}) {
  const publishRound = useMutation(api.reviewConfiguration.publishRound);
  const nextCriterionIdRef = useRef(5);
  const nextPanelIdRef = useRef(2);
  const nextMemberIdRef = useRef(1);
  const publishAttempt =
    useMutationAttempt<FunctionReturnType<typeof api.reviewConfiguration.publishRound>>();
  const publishPending = publishAttempt.hasPending("review-round-publish");
  const [rubricName, setRubricName] = useState("Code2Create project review");
  const [spreadThreshold, setSpreadThreshold] = useState("2");
  const [criteria, setCriteria] = useState<CriterionDraft[]>(initialCriteria);
  const [round, setRound] = useState<RoundDraft>({
    stableKey: `review_${nextSequence}`,
    name: `Project review ${nextSequence}`,
    sequence: `${nextSequence}`,
    clockInOpensAt: "",
    reviewerReportAt: "",
    startsAt: "",
    endsAt: "",
    noShowGraceSeconds: "180",
    correctionRequestsCloseAt: "",
    reviewDurationMinutes: "10",
    ordinaryExtensionMinutes: "2",
    maximumOrdinaryExtensions: "1",
    missedCallGraceSeconds: "180",
    requiredCallAttempts: "2",
    substituteResponseSeconds: "90",
    missedReentryPolicy: "preserve_queue_time",
    requiredPanelSize: "3",
    minimumScorersPerCriterion: "2",
    minimumPresentParticipants: "2",
    minimumReviewerBuild: "1",
    requiresSharedCommitments: true,
    requiresCamera: true,
    requiresNotifications: true,
  });
  const [panels, setPanels] = useState<PanelDraft[]>([
    { id: "panel-1", stableKey: "panel_1", name: "Panel 1", members: [] },
  ]);
  const [reservePersonIds, setReservePersonIds] = useState<PersonId[]>([]);
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const readyCandidates = candidates.filter(
    (candidate) =>
      candidate.profile?.status === "active" &&
      candidate.profile.trainingStatus === "complete" &&
      candidate.profile.criterionKeys.length > 0 &&
      candidate.profile.availabilityWindows.length > 0,
  );

  const changed = () => {
    setConfirmed(false);
    setError(null);
    setSuccess(null);
  };

  const updateCriterion = (id: string, update: (current: CriterionDraft) => CriterionDraft) => {
    setCriteria((current) =>
      current.map((criterion) => (criterion.id === id ? update(criterion) : criterion)),
    );
    changed();
  };

  const addCriterion = () => {
    const id = `criterion-${nextCriterionIdRef.current}`;
    nextCriterionIdRef.current += 1;
    setCriteria((current) => [
      ...current,
      {
        id,
        stableKey: `criterion_${current.length + 1}`,
        label: "New criterion",
        question: "What should reviewers assess?",
        guidance: "State the evidence reviewers should use.",
        weight: "10",
        anchors: {
          zero: "No evidence.",
          one: "Very limited evidence.",
          two: "Adequate evidence.",
          three: "Strong evidence.",
          four: "Exceptional evidence.",
        },
      },
    ]);
    changed();
  };

  const removeCriterion = (id: string) => {
    if (criteria.length <= 1) return;
    setCriteria((current) => current.filter((criterion) => criterion.id !== id));
    setPanels((current) =>
      current.map((panel) => ({
        ...panel,
        members: panel.members.map((member) => ({
          ...member,
          criterionIds: member.criterionIds.filter((criterionId) => criterionId !== id),
        })),
      })),
    );
    changed();
  };

  const updatePanel = (id: string, update: (current: PanelDraft) => PanelDraft) => {
    setPanels((current) => current.map((panel) => (panel.id === id ? update(panel) : panel)));
    changed();
  };

  const addPanel = () => {
    const sequence = nextPanelIdRef.current;
    nextPanelIdRef.current += 1;
    setPanels((current) => [
      ...current,
      {
        id: `panel-${sequence}`,
        stableKey: `panel_${sequence}`,
        name: `Panel ${sequence}`,
        members: [],
      },
    ]);
    changed();
  };

  const addMember = (panelId: string) => {
    const used = new Set(panels.flatMap((panel) => panel.members.map((member) => member.personId)));
    const available = readyCandidates.find((candidate) => !used.has(candidate.personId));
    const memberId = `member-${nextMemberIdRef.current}`;
    nextMemberIdRef.current += 1;
    if (available) {
      setReservePersonIds((current) =>
        current.filter((personId) => personId !== available.personId),
      );
    }
    updatePanel(panelId, (panel) => ({
      ...panel,
      members: [
        ...panel.members,
        {
          id: memberId,
          personId: available?.personId ?? "",
          criterionIds: available
            ? criteria
                .filter((criterion) =>
                  available.profile?.criterionKeys.includes(criterion.stableKey),
                )
                .map((criterion) => criterion.id)
            : [],
          isCoordinator: panel.members.length === 0,
        },
      ],
    }));
  };

  const removeMember = (panelId: string, memberId: string) => {
    updatePanel(panelId, (panel) => {
      const remaining = panel.members.filter((member) => member.id !== memberId);
      if (remaining.some((member) => member.isCoordinator) || remaining.length === 0) {
        return { ...panel, members: remaining };
      }
      return {
        ...panel,
        members: remaining.map((member, index) => ({ ...member, isCoordinator: index === 0 })),
      };
    });
  };

  const publish = async (event: SubmitEvent) => {
    event.preventDefault();
    if (!canPublish || !confirmed) return;
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      await publishAttempt.run("review-round-publish", () => {
        const requiredPanelSize = positiveInteger(round.requiredPanelSize, "Panel size");
        if (panels.some((panel) => panel.members.length !== requiredPanelSize)) {
          throw new Error(`Every panel must contain exactly ${requiredPanelSize} reviewers.`);
        }
        const reviewerIds = panels.flatMap((panel) =>
          panel.members.map((member) => member.personId),
        );
        if (
          reviewerIds.some((personId) => !personId) ||
          new Set(reviewerIds).size !== reviewerIds.length
        ) {
          throw new Error("Choose a different trained reviewer for every panel seat.");
        }
        if (reservePersonIds.some((personId) => reviewerIds.includes(personId))) {
          throw new Error("A panel reviewer cannot also be selected as a reserve.");
        }
        const mappedPanels = panels.map((panel) => ({
          stableKey: panel.stableKey,
          name: panel.name,
          members: panel.members.map((member) => {
            const candidate = readyCandidates.find((item) => item.personId === member.personId);
            if (!candidate)
              throw new Error("A selected reviewer is no longer active, or has not finished training.");
            const criterionKeys = member.criterionIds.map((criterionId) => {
              const criterion = criteria.find((item) => item.id === criterionId);
              if (!criterion)
                throw new Error("A criterion assigned to a reviewer no longer exists.");
              return criterion.stableKey;
            });
            return {
              personId: candidate.personId,
              criterionKeys,
              isCoordinator: member.isCoordinator,
            };
          }),
        }));
        const args = {
          eventSlug,
          rubric: {
            name: rubricName,
            spreadThreshold: boundedInteger(spreadThreshold, "How far scores may differ", 1, 4),
            criteria: criteria.map((criterion, index) => ({
              stableKey: criterion.stableKey,
              label: criterion.label,
              question: criterion.question,
              guidance: criterion.guidance,
              weight: positiveInteger(criterion.weight, `${criterion.label} weight`),
              displayOrder: index,
              anchors: criterion.anchors,
            })),
          },
          round: {
            stableKey: round.stableKey,
            name: round.name,
            sequence: positiveInteger(round.sequence, "Round order"),
            clockInOpensAt: timestamp(round.clockInOpensAt, "Clock-in opening"),
            reviewerReportAt: timestamp(round.reviewerReportAt, "Reviewer report time"),
            startsAt: timestamp(round.startsAt, "Round start"),
            endsAt: timestamp(round.endsAt, "Round end"),
            noShowGraceSeconds: boundedInteger(
              round.noShowGraceSeconds,
              "Reviewer no-show grace",
              30,
              1_800,
            ),
            correctionRequestsCloseAt: timestamp(
              round.correctionRequestsCloseAt,
              "Score-correction request deadline",
            ),
            reviewDurationSeconds:
              positiveInteger(round.reviewDurationMinutes, "Review duration") * 60,
            ordinaryExtensionSeconds:
              nonnegativeInteger(round.ordinaryExtensionMinutes, "Extension duration") * 60,
            maximumOrdinaryExtensions: nonnegativeInteger(
              round.maximumOrdinaryExtensions,
              "Extension count",
            ),
            missedCallGraceSeconds: positiveInteger(
              round.missedCallGraceSeconds,
              "Missed-call grace",
            ),
            requiredCallAttempts: positiveInteger(
              round.requiredCallAttempts,
              "Required call attempts",
            ),
            substituteResponseSeconds: positiveInteger(
              round.substituteResponseSeconds,
              "Substitute response window",
            ),
            missedReentryPolicy: round.missedReentryPolicy,
            requiredPanelSize,
            minimumScorersPerCriterion: positiveInteger(
              round.minimumScorersPerCriterion,
              "Minimum scorers",
            ),
            minimumPresentParticipants: positiveInteger(
              round.minimumPresentParticipants,
              "Minimum participants",
            ),
            requiresSharedCommitments: round.requiresSharedCommitments,
            minimumReviewerBuild: positiveInteger(
              round.minimumReviewerBuild,
              "Minimum reviewer build",
            ),
            requiresCamera: round.requiresCamera,
            requiresNotifications: round.requiresNotifications,
          },
          panels: mappedPanels,
          reservePersonIds,
          reason,
          clientOperationId: crypto.randomUUID(),
        };
        return () => publishRound(args);
      });
      setConfirmed(false);
      setSuccess(`Published ${round.name}.`);
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="setup-section">
      <h2>
        <span className="step-number">1</span>Round timing and rules
      </h2>
      <p className="muted">
        Publishing locks the staffing times, no-show grace, rubric, panels, coordinators, and
        reviewer coverage.
      </p>
      <form className="review-publisher" onSubmit={publish}>
        <fieldset disabled={publishPending} style={{ display: "contents" }}>
          <div className="form-grid">
            <label className="field">
              <span>Round name</span>
              <input
                value={round.name}
                onChange={(event) => {
                  setRound((current) => ({ ...current, name: event.target.value }));
                  changed();
                }}
              />
            </label>
            <label className="field">
              <span>
                Clock-in opens <small>Event local time</small>
              </span>
              <input
                type="datetime-local"
                value={round.clockInOpensAt}
                onChange={(event) => {
                  setRound((current) => ({ ...current, clockInOpensAt: event.target.value }));
                  changed();
                }}
              />
            </label>
            <label className="field">
              <span>
                Reviewers report <small>Event local time</small>
              </span>
              <input
                type="datetime-local"
                value={round.reviewerReportAt}
                onChange={(event) => {
                  setRound((current) => ({ ...current, reviewerReportAt: event.target.value }));
                  changed();
                }}
              />
            </label>
            <label className="field">
              <span>
                Starts <small>Event local time</small>
              </span>
              <input
                type="datetime-local"
                value={round.startsAt}
                onChange={(event) => {
                  setRound((current) => ({ ...current, startsAt: event.target.value }));
                  changed();
                }}
              />
            </label>
            <label className="field">
              <span>
                Ends <small>Event local time</small>
              </span>
              <input
                type="datetime-local"
                value={round.endsAt}
                onChange={(event) => {
                  setRound((current) => ({ ...current, endsAt: event.target.value }));
                  changed();
                }}
              />
            </label>
            <label className="field">
              <span>
                Correction requests close <small>Event local time</small>
              </span>
              <input
                type="datetime-local"
                value={round.correctionRequestsCloseAt}
                onChange={(event) => {
                  setRound((current) => ({
                    ...current,
                    correctionRequestsCloseAt: event.target.value,
                  }));
                  changed();
                }}
              />
            </label>
            <label className="field">
              <span>Reviewer no-show grace · seconds</span>
              <input
                inputMode="numeric"
                value={round.noShowGraceSeconds}
                onChange={(event) => {
                  setRound((current) => ({ ...current, noShowGraceSeconds: event.target.value }));
                  changed();
                }}
              />
            </label>
            <label className="field">
              <span>Review duration · minutes</span>
              <input
                inputMode="numeric"
                value={round.reviewDurationMinutes}
                onChange={(event) => {
                  setRound((current) => ({
                    ...current,
                    reviewDurationMinutes: event.target.value,
                  }));
                  changed();
                }}
              />
            </label>
            <label className="field">
              <span>Reviewers per panel</span>
              <input
                inputMode="numeric"
                value={round.requiredPanelSize}
                onChange={(event) => {
                  setRound((current) => ({ ...current, requiredPanelSize: event.target.value }));
                  changed();
                }}
              />
            </label>
            <label className="field">
              <span>Reviewers per criterion</span>
              <input
                inputMode="numeric"
                value={round.minimumScorersPerCriterion}
                onChange={(event) => {
                  setRound((current) => ({
                    ...current,
                    minimumScorersPerCriterion: event.target.value,
                  }));
                  changed();
                }}
              />
            </label>
            <label className="field">
              <span>Team members needed at review</span>
              <input
                inputMode="numeric"
                value={round.minimumPresentParticipants}
                onChange={(event) => {
                  setRound((current) => ({
                    ...current,
                    minimumPresentParticipants: event.target.value,
                  }));
                  changed();
                }}
              />
            </label>
          </div>

          <details className="configuration-advanced review-advanced">
            <summary>Advanced round rules</summary>
            <div className="form-grid">
              <label className="field">
                <span>Round order</span>
                <input
                  inputMode="numeric"
                  value={round.sequence}
                  onChange={(event) => {
                    setRound((current) => ({ ...current, sequence: event.target.value }));
                    changed();
                  }}
                />
              </label>
              <label className="field">
                <span>Oldest reviewer app allowed</span>
                <input
                  inputMode="numeric"
                  value={round.minimumReviewerBuild}
                  onChange={(event) => {
                    setRound((current) => ({
                      ...current,
                      minimumReviewerBuild: event.target.value,
                    }));
                    changed();
                  }}
                />
              </label>
              <label className="field">
                <span>Extra time · minutes</span>
                <input
                  inputMode="numeric"
                  value={round.ordinaryExtensionMinutes}
                  onChange={(event) => {
                    setRound((current) => ({
                      ...current,
                      ordinaryExtensionMinutes: event.target.value,
                    }));
                    changed();
                  }}
                />
              </label>
              <label className="field">
                <span>Maximum extra-time uses</span>
                <input
                  inputMode="numeric"
                  value={round.maximumOrdinaryExtensions}
                  onChange={(event) => {
                    setRound((current) => ({
                      ...current,
                      maximumOrdinaryExtensions: event.target.value,
                    }));
                    changed();
                  }}
                />
              </label>
              <label className="field">
                <span>Grace after a call · seconds</span>
                <input
                  inputMode="numeric"
                  value={round.missedCallGraceSeconds}
                  onChange={(event) => {
                    setRound((current) => ({
                      ...current,
                      missedCallGraceSeconds: event.target.value,
                    }));
                    changed();
                  }}
                />
              </label>
              <label className="field">
                <span>Calls before a team is marked missed</span>
                <input
                  inputMode="numeric"
                  value={round.requiredCallAttempts}
                  onChange={(event) => {
                    setRound((current) => ({
                      ...current,
                      requiredCallAttempts: event.target.value,
                    }));
                    changed();
                  }}
                />
              </label>
              <label className="field">
                <span>Reserve response time · seconds</span>
                <input
                  inputMode="numeric"
                  value={round.substituteResponseSeconds}
                  onChange={(event) => {
                    setRound((current) => ({
                      ...current,
                      substituteResponseSeconds: event.target.value,
                    }));
                    changed();
                  }}
                />
              </label>
              <label className="field">
                <span>After a missed call</span>
                <select
                  value={round.missedReentryPolicy}
                  onChange={(event) => {
                    const value = event.target.value;
                    setRound((current) => ({
                      ...current,
                      missedReentryPolicy:
                        value === "queue_end" || value === "manual" ? value : "preserve_queue_time",
                    }));
                    changed();
                  }}
                >
                  <option value="preserve_queue_time">
                    Keep their original place in the queue
                  </option>
                  <option value="queue_end">Move to the back of the queue</option>
                  <option value="manual">Place panels by hand</option>
                </select>
              </label>
            </div>
            <div className="review-policy-checks">
              <PolicyCheck
                label="Panels must record findings and next steps"
                checked={round.requiresSharedCommitments}
                onChange={(checked) => {
                  setRound((current) => ({ ...current, requiresSharedCommitments: checked }));
                  changed();
                }}
              />
              <PolicyCheck
                label="Reviewers must have a working camera"
                checked={round.requiresCamera}
                onChange={(checked) => {
                  setRound((current) => ({ ...current, requiresCamera: checked }));
                  changed();
                }}
              />
              <PolicyCheck
                label="Reviewers must allow notifications"
                checked={round.requiresNotifications}
                onChange={(checked) => {
                  setRound((current) => ({ ...current, requiresNotifications: checked }));
                  changed();
                }}
              />
            </div>
          </details>

          <section className="publisher-block">
            <div className="section-heading">
              <div>
                <h2>
                  <span className="step-number">2</span>Rubric
                </h2>
                <p className="muted">
                  Weights are whole numbers that add up to 100. Every score is 0–4, with the wording
                  below.
                </p>
              </div>
              <button className="secondary" type="button" onClick={addCriterion}>
                Add criterion
              </button>
            </div>
            <label className="field rubric-name-field">
              <span>Rubric name</span>
              <input
                value={rubricName}
                onChange={(event) => {
                  setRubricName(event.target.value);
                  changed();
                }}
              />
            </label>
            <label className="field rubric-name-field">
              <span>Flag rating spreads of</span>
              <input
                inputMode="numeric"
                min={1}
                max={4}
                type="number"
                value={spreadThreshold}
                onChange={(event) => {
                  setSpreadThreshold(event.target.value);
                  changed();
                }}
              />
              <small className="muted">
                A criterion is flagged when its highest and lowest ratings differ by this many
                points.
              </small>
            </label>
            <div className="criterion-editors">
              {criteria.map((criterion) => (
                <CriterionEditor
                  canRemove={criteria.length > 1}
                  criterion={criterion}
                  key={criterion.id}
                  onRemove={() => removeCriterion(criterion.id)}
                  onUpdate={(update) => updateCriterion(criterion.id, update)}
                />
              ))}
            </div>
            <p className="weight-total">
              Current weight total:{" "}
              {criteria.reduce((total, criterion) => total + numericValue(criterion.weight), 0)}
            </p>
          </section>

          <section className="publisher-block">
            <div className="section-heading">
              <div>
                <h2>
                  <span className="step-number">3</span>Panels
                </h2>
                <p className="muted">
                  Each reviewer can appear once. One coordinator is required per panel.
                </p>
              </div>
              <button className="secondary" type="button" onClick={addPanel}>
                Add panel
              </button>
            </div>
            {readyCandidates.length === 0 ? (
              <p className="notice">No trained, active reviewer is available.</p>
            ) : null}
            <div className="panel-editors">
              {panels.map((panel) => (
                <PanelEditor
                  allPanels={panels}
                  canRemove={panels.length > 1}
                  candidates={readyCandidates}
                  criteria={criteria}
                  key={panel.id}
                  onAddMember={() => addMember(panel.id)}
                  onRemove={() => {
                    setPanels((current) => current.filter((item) => item.id !== panel.id));
                    changed();
                  }}
                  onRemoveMember={(memberId) => removeMember(panel.id, memberId)}
                  onReviewerSelected={(personId) => {
                    if (personId) {
                      setReservePersonIds((current) => current.filter((id) => id !== personId));
                    }
                  }}
                  onUpdate={(update) => updatePanel(panel.id, update)}
                  panel={panel}
                />
              ))}
            </div>
          </section>

          <section className="publisher-block">
            <div className="section-heading">
              <div>
                <h2>
                  <span className="step-number">4</span>Reserves
                </h2>
                <p className="muted">
                  Trained reviewers not on a panel can be called in to fill an empty seat.
                </p>
              </div>
            </div>
            <div className="criterion-assignment-list">
              {readyCandidates.map((candidate) => {
                const panelReviewer = panels.some((panel) =>
                  panel.members.some((member) => member.personId === candidate.personId),
                );
                const selected = reservePersonIds.includes(candidate.personId);
                return (
                  <label className="check-filter" key={candidate.personId}>
                    <input
                      checked={!panelReviewer && selected}
                      disabled={panelReviewer}
                      type="checkbox"
                      onChange={(event) => {
                        setReservePersonIds((current) =>
                          event.target.checked
                            ? [...current, candidate.personId]
                            : current.filter((personId) => personId !== candidate.personId),
                        );
                        changed();
                      }}
                    />
                    {candidate.displayName} · {candidate.profile?.criterionKeys.length ?? 0} review{" "}
                    {candidate.profile?.criterionKeys.length === 1 ? "area" : "areas"}
                  </label>
                );
              })}
              {readyCandidates.length === 0 ? (
                <p className="notice">
                  Set up at least one trained reviewer and choose what they can judge.
                </p>
              ) : null}
            </div>
          </section>
        </fieldset>
        <section className="publish-confirmation">
          <h2>
            <span className="step-number">5</span>Publish
          </h2>
          <p className="muted">Publishing locks this round.</p>
          <label className="field">
            <span>Why this is being published</span>
            <textarea
              disabled={publishPending}
              required
              value={reason}
              onChange={(event) => {
                setReason(event.target.value);
                changed();
              }}
            />
          </label>
          <label className="check-filter publication-check">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={publishPending}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            I reviewed the clock-in and report times, no-show grace, rubric weights, panel seats,
            coordinators, and reviewer availability.
          </label>
          <button
            className="primary"
            type="submit"
            disabled={!canPublish || busy || !confirmed || reason.trim().length < 5}
          >
            {busy
              ? "Publishing…"
              : publishPending
                ? "Confirm earlier publication"
                : canPublish
                  ? "Publish round"
                  : "You cannot publish this round"}
          </button>
        </section>
      </form>
      {error ? (
        <p className="notice error" role="alert">
          {error}
        </p>
      ) : null}
      {success ? (
        <p className="notice" role="status">
          {success}
        </p>
      ) : null}
    </section>
  );
}

function CriterionEditor({
  criterion,
  canRemove,
  onUpdate,
  onRemove,
}: {
  criterion: CriterionDraft;
  canRemove: boolean;
  onUpdate: (update: (current: CriterionDraft) => CriterionDraft) => void;
  onRemove: () => void;
}) {
  const updateAnchor = (key: keyof Anchors, value: string) => {
    onUpdate((current) => ({ ...current, anchors: { ...current.anchors, [key]: value } }));
  };
  return (
    <details className="criterion-editor">
      <summary>
        {criterion.label} · {criterion.weight}%
      </summary>
      <div className="criterion-editor-body">
        <div className="form-grid">
          <label className="field">
            <span>Weight</span>
            <input
              inputMode="numeric"
              value={criterion.weight}
              onChange={(event) =>
                onUpdate((current) => ({ ...current, weight: event.target.value }))
              }
            />
          </label>
          <label className="field full-field">
            <span>Label</span>
            <input
              value={criterion.label}
              onChange={(event) =>
                onUpdate((current) => ({ ...current, label: event.target.value }))
              }
            />
          </label>
          <label className="field full-field">
            <span>Question</span>
            <textarea
              value={criterion.question}
              onChange={(event) =>
                onUpdate((current) => ({ ...current, question: event.target.value }))
              }
            />
          </label>
          <label className="field full-field">
            <span>Guidance</span>
            <textarea
              value={criterion.guidance}
              onChange={(event) =>
                onUpdate((current) => ({ ...current, guidance: event.target.value }))
              }
            />
          </label>
        </div>
        <details className="configuration-advanced">
          <summary>Internal name</summary>
          <label className="field">
            <span>Internal name</span>
            <input
              value={criterion.stableKey}
              onChange={(event) =>
                onUpdate((current) => ({ ...current, stableKey: event.target.value }))
              }
            />
          </label>
        </details>
        <div className="anchor-grid">
          <AnchorField
            label="0"
            value={criterion.anchors.zero}
            onChange={(value) => updateAnchor("zero", value)}
          />
          <AnchorField
            label="1"
            value={criterion.anchors.one}
            onChange={(value) => updateAnchor("one", value)}
          />
          <AnchorField
            label="2"
            value={criterion.anchors.two}
            onChange={(value) => updateAnchor("two", value)}
          />
          <AnchorField
            label="3"
            value={criterion.anchors.three}
            onChange={(value) => updateAnchor("three", value)}
          />
          <AnchorField
            label="4"
            value={criterion.anchors.four}
            onChange={(value) => updateAnchor("four", value)}
          />
        </div>
        {canRemove ? (
          <button className="text-button" type="button" onClick={onRemove}>
            Remove criterion
          </button>
        ) : null}
      </div>
    </details>
  );
}

function AnchorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="field">
      <span>Score {label}</span>
      <textarea value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function PanelEditor({
  panel,
  allPanels,
  candidates,
  criteria,
  canRemove,
  onUpdate,
  onAddMember,
  onRemoveMember,
  onReviewerSelected,
  onRemove,
}: {
  panel: PanelDraft;
  allPanels: PanelDraft[];
  candidates: Candidate[];
  criteria: CriterionDraft[];
  canRemove: boolean;
  onUpdate: (update: (current: PanelDraft) => PanelDraft) => void;
  onAddMember: () => void;
  onRemoveMember: (memberId: string) => void;
  onReviewerSelected: (personId: string) => void;
  onRemove: () => void;
}) {
  const usedReviewerIds = new Set(
    allPanels.flatMap((item) => item.members.map((member) => member.personId)),
  );
  const updateMember = (memberId: string, update: (current: MemberDraft) => MemberDraft) => {
    onUpdate((current) => ({
      ...current,
      members: current.members.map((member) => (member.id === memberId ? update(member) : member)),
    }));
  };
  return (
    <article className="panel-editor">
      <div className="form-grid">
        <label className="field full-field">
          <span>Panel name</span>
          <input
            value={panel.name}
            onChange={(event) => onUpdate((current) => ({ ...current, name: event.target.value }))}
          />
        </label>
      </div>
      <div className="panel-member-list">
        {panel.members.map((member) => (
          <div className="panel-member" key={member.id}>
            <div className="panel-member-heading">
              <label className="field">
                <span>Reviewer</span>
                <select
                  value={member.personId}
                  onChange={(event) => {
                    const personId = event.target.value;
                    const candidate = candidates.find((item) => item.personId === personId);
                    updateMember(member.id, (current) => ({
                      ...current,
                      personId,
                      criterionIds: candidate
                        ? criteria
                            .filter((criterion) =>
                              candidate.profile?.criterionKeys.includes(criterion.stableKey),
                            )
                            .map((criterion) => criterion.id)
                        : [],
                    }));
                    onReviewerSelected(personId);
                  }}
                >
                  <option value="">Choose reviewer</option>
                  {candidates.map((candidate) => (
                    <option
                      disabled={
                        usedReviewerIds.has(candidate.personId) &&
                        candidate.personId !== member.personId
                      }
                      key={candidate.personId}
                      value={candidate.personId}
                    >
                      {candidate.displayName} · {candidate.email}
                    </option>
                  ))}
                </select>
              </label>
              <label className="check-filter coordinator-choice">
                <input
                  checked={member.isCoordinator}
                  name={`coordinator-${panel.id}`}
                  type="radio"
                  onChange={() =>
                    onUpdate((current) => ({
                      ...current,
                      members: current.members.map((item) => ({
                        ...item,
                        isCoordinator: item.id === member.id,
                      })),
                    }))
                  }
                />
                Coordinator
              </label>
              <button
                className="text-button"
                type="button"
                onClick={() => onRemoveMember(member.id)}
              >
                Remove
              </button>
            </div>
            <div className="criterion-assignment-list">
              {criteria.map((criterion) => {
                const assigned = member.criterionIds.includes(criterion.id);
                const selectedCandidate = candidates.find(
                  (candidate) => candidate.personId === member.personId,
                );
                const qualified =
                  selectedCandidate?.profile?.criterionKeys.includes(criterion.stableKey) ?? false;
                return (
                  <label className="check-filter" key={criterion.id}>
                    <input
                      checked={assigned}
                      disabled={!qualified && !assigned}
                      type="checkbox"
                      onChange={(event) =>
                        updateMember(member.id, (current) => ({
                          ...current,
                          criterionIds: event.target.checked
                            ? [...current.criterionIds, criterion.id]
                            : current.criterionIds.filter((id) => id !== criterion.id),
                        }))
                      }
                    />
                    {criterion.label}
                    {qualified ? "" : " · not qualified"}
                  </label>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="button-row">
        <button className="secondary" type="button" onClick={onAddMember}>
          Add reviewer
        </button>
        {canRemove ? (
          <button className="text-button" type="button" onClick={onRemove}>
            Remove panel
          </button>
        ) : null}
      </div>
    </article>
  );
}

function PolicyCheck({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="check-filter">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      {label}
    </label>
  );
}

function commaList(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function trainingStatusValue(value: string, fallback: TrainingStatus): TrainingStatus {
  if (value === "pending" || value === "complete" || value === "blocked") return value;
  return fallback;
}

function trainingStatusName(value: TrainingStatus | undefined) {
  if (value === "complete") return "Ready";
  if (value === "pending") return "Training pending";
  if (value === "blocked") return "Unavailable";
  return "Not set up";
}

function numericValue(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function positiveInteger(value: string, label: string) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw new Error(`${label} must be a positive whole number.`);
  return parsed;
}

function boundedInteger(value: string, label: string, minimum: number, maximum: number) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be a whole number from ${minimum} through ${maximum}.`);
  }
  return parsed;
}

function nonnegativeInteger(value: string, label: string) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw new Error(`${label} must be zero or a positive whole number.`);
  return parsed;
}

function timestamp(value: string, label: string) {
  const parsed = new Date(value).getTime();
  if (!Number.isFinite(parsed)) throw new Error(`${label} is required.`);
  return parsed;
}

function localDateTime(value: number) {
  const date = new Date(value);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatMoment(value: number) {
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(value);
}

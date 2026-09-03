import type { api } from "@code2create/backend/api";
import {
  applicationDecisionLabels,
  studyYearLabels,
  type AdmissionRecommendationState,
  type ApplicationDecision,
  type ApplicationState,
  type ParticipantClass,
  type StudyYear,
} from "@code2create/domain";
import type { FunctionReturnType } from "convex/server";

type ApplicationPage = FunctionReturnType<typeof api.admissions.list>;
export type QueueApplication = ApplicationPage["page"][number];
type AssignmentPage = FunctionReturnType<typeof api.admissions.myReviewAssignments>;
export type QueueAssignment = AssignmentPage["page"][number];
export type StageCount = FunctionReturnType<typeof api.admissions.stageCounts>[number];
export type ReviewAssignmentCounts = FunctionReturnType<
  typeof api.admissions.myReviewAssignmentCounts
>;
export type ReviewerWorkload = FunctionReturnType<typeof api.admissions.reviewerWorkload>[number];
export type RosterCohortMember = { participantClass: ParticipantClass; yearOfStudy: StudyYear };
export type ReviewStatusTone = "done" | "waiting" | "unassigned";
export type AiStateTagTone = "accept" | "waitlist" | "decline" | "neutral";
export type AssignmentOutcome = { teamName: string; ok: boolean; message?: string };

export const applicationStageOrder: readonly ApplicationState[] = [
  "submitted",
  "under_review",
  "accepted",
  "offer_sent",
  "confirmed",
  "waitlisted",
  "declined",
  "offer_expired",
  "withdrawn",
];

/** The stages that still take ordinary reviews and assignments. */
export function stageAcceptsReviews(state: ApplicationState) {
  return state === "submitted" || state === "under_review";
}

export function stageCountMap(counts: readonly StageCount[]) {
  return new Map<ApplicationState, number>(counts.map((row) => [row.state, row.count]));
}

export function busiestStage(
  counts: ReadonlyMap<ApplicationState, number>,
): ApplicationState | null {
  return applicationStageOrder.find((stage) => (counts.get(stage) ?? 0) > 0) ?? null;
}

/** Only stages with something in them earn a chip; the chosen one always stays. */
export function visibleStages(
  counts: ReadonlyMap<ApplicationState, number>,
  selected: ApplicationState,
): ApplicationState[] {
  return applicationStageOrder.filter(
    (stage) => stage === selected || (counts.get(stage) ?? 0) > 0,
  );
}

export function parseApplicationStage(value: string): ApplicationState {
  return applicationStageOrder.find((stage) => stage === value) ?? "submitted";
}

export function queueLeadSentence(
  counts: ReadonlyMap<ApplicationState, number>,
  oneReviewOnly = false,
): string {
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  if (total === 0) {
    return oneReviewOnly ? "No team has exactly 1 review in." : "No team has applied yet.";
  }
  const clauses: string[] = [];
  const submitted = counts.get("submitted") ?? 0;
  const underReview = counts.get("under_review") ?? 0;
  const accepted = counts.get("accepted") ?? 0;
  const offered = counts.get("offer_sent") ?? 0;
  if (submitted > 0)
    clauses.push(`${submitted} ${submitted === 1 ? "needs" : "need"} a first review`);
  if (underReview > 0)
    clauses.push(`${underReview} ${underReview === 1 ? "is" : "are"} being reviewed`);
  if (accepted > 0) clauses.push(`${accepted} accepted without an offer yet`);
  if (offered > 0) clauses.push(`${offered} waiting for the team to confirm`);
  if (clauses.length === 0)
    return `${total} ${total === 1 ? "application" : "applications"}, all decided.`;
  return `${joinClauses(clauses.slice(0, 3))}.`;
}

export function completedReviewCountQueryArgs(oneReviewOnly: boolean): {
  completedReviewCount?: 1;
} {
  return oneReviewOnly ? { completedReviewCount: 1 } : {};
}

export function reviewerLeadSentence(counts: ReviewAssignmentCounts | undefined): string {
  if (counts === undefined) return "";
  if (counts.active === 0 && counts.completed === 0)
    return "Nothing is assigned to you yet. A coordinator hands out applications from the full list.";
  if (counts.active === 0) return `Nothing left to review. ${counts.completed} done.`;
  return `${counts.active} ${counts.active === 1 ? "application" : "applications"} to review, ${counts.completed} done.`;
}

const numberedYears = [
  "first",
  "second",
  "third",
  "fourth",
  "fifth_or_later",
] as const satisfies readonly StudyYear[];
type NumberedYear = (typeof numberedYears)[number];
const numberedYearWords: Record<NumberedYear, string> = {
  first: "first",
  second: "second",
  third: "third",
  fourth: "fourth",
  fifth_or_later: "fifth or later",
};

/**
 * The team's years, said plainly: "First year", "Second and third year",
 * "External", or "Third year, external" when a team mixes both.
 */
export function cohortSummary(cohort: readonly RosterCohortMember[]): string {
  const years = new Set<StudyYear>();
  let external = false;
  for (const member of cohort) {
    if (member.participantClass === "external_participant") external = true;
    else years.add(member.yearOfStudy);
  }
  const numbered = numberedYears.filter((year) => years.has(year));
  const parts: string[] = [];
  if (numbered.length === 1) {
    parts.push(studyYearLabels[numbered[0] ?? "first"]);
  } else if (numbered.length > 1) {
    parts.push(`${joinClauses(numbered.map((year) => numberedYearWords[year]))} year`);
  }
  if (years.has("postgraduate")) parts.push(studyYearLabels.postgraduate);
  if (years.has("not_applicable")) parts.push(studyYearLabels.not_applicable);
  if (external) parts.push("External");
  return parts
    .map((part, index) => (index === 0 ? capitalize(part) : part.toLowerCase()))
    .join(", ");
}

export function teamLine(
  memberCount: number,
  cohort: readonly RosterCohortMember[] | undefined,
): string {
  const members = `${memberCount} ${memberCount === 1 ? "member" : "members"}`;
  if (cohort === undefined || cohort.length === 0) return members;
  return `${members} · ${cohortSummary(cohort)}`;
}

export function memberContextLine(context: RosterCohortMember & { institution: string }): string {
  const year =
    context.participantClass === "external_participant"
      ? "External participant"
      : studyYearLabels[context.yearOfStudy];
  return `${year} · ${context.institution}`;
}

export function reviewStatus(application: {
  completedReviewCount: number;
  assignedReviewCount: number;
  minimumHumanReviews: number;
}): { text: string; tone: ReviewStatusTone } {
  const {
    completedReviewCount: completed,
    assignedReviewCount: assigned,
    minimumHumanReviews: minimum,
  } = application;
  const reviews = `${completed} of ${minimum} ${minimum === 1 ? "review" : "reviews"} in`;
  if (completed >= minimum) return { text: reviews, tone: "done" };
  if (assigned > 0) return { text: `${reviews} · ${assigned} assigned`, tone: "waiting" };
  return { text: `${reviews} · nobody assigned`, tone: "unassigned" };
}

export function aiStateTag(
  state: AdmissionRecommendationState | undefined,
  recommendation?: ApplicationDecision,
): { text: string; tone: AiStateTagTone } | null {
  if (state === undefined || state === "disabled") return null;
  if (state === "pending" || state === "running") {
    return { text: "Idea agent · Preparing", tone: "neutral" };
  }
  if (state === "succeeded" && recommendation !== undefined) {
    return {
      text: `Idea agent · ${applicationDecisionLabels[recommendation]}`,
      tone: recommendation,
    };
  }
  if (state === "succeeded") return { text: "Idea agent · Ready", tone: "neutral" };
  if (state === "stale") return { text: "Idea agent · Out of date", tone: "neutral" };
  return { text: "Idea agent · Unavailable", tone: "neutral" };
}

export function ownReviewLine(assignment: { ownRecommendation?: ApplicationDecision }): {
  text: string;
  done: boolean;
} {
  if (assignment.ownRecommendation === undefined) return { text: "Not reviewed yet", done: false };
  return {
    text: `You said ${applicationDecisionLabels[assignment.ownRecommendation].toLowerCase()}`,
    done: true,
  };
}

export function nextAssignmentId(
  assignments: readonly { applicationId: string }[],
  currentApplicationId: string,
): string | null {
  return (
    assignments.find((assignment) => assignment.applicationId !== currentApplicationId)
      ?.applicationId ?? null
  );
}

export function assignmentOutcomeSummary(
  outcomes: readonly AssignmentOutcome[],
  reviewerEmail: string,
): string {
  const assigned = outcomes.filter((outcome) => outcome.ok).length;
  const failed = outcomes.length - assigned;
  const sentences: string[] = [];
  if (assigned > 0)
    sentences.push(
      `Assigned ${assigned} ${assigned === 1 ? "application" : "applications"} to ${reviewerEmail}.`,
    );
  if (failed > 0) sentences.push(`${failed} could not be assigned.`);
  return sentences.join(" ");
}

function joinClauses(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1) ?? ""}`;
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** Still short of reviews with nobody on it: the rows a coordinator hands out first. */
export function needsAssignment(application: {
  completedReviewCount: number;
  assignedReviewCount: number;
  minimumHumanReviews: number;
}) {
  return (
    application.assignedReviewCount === 0 &&
    application.completedReviewCount < application.minimumHumanReviews
  );
}

export function reviewerWorkloadLabel(
  reviewer: Pick<ReviewerWorkload, "active" | "completed">,
): string {
  if (reviewer.active === 0) return `${reviewer.completed} done`;
  return `${reviewer.active} open`;
}

export function remainingAssignmentsLine(
  counts: ReviewAssignmentCounts | undefined,
): string | null {
  if (counts === undefined || counts.active === 0) return null;
  return `${counts.active} more ${counts.active === 1 ? "is" : "are"} assigned to you.`;
}

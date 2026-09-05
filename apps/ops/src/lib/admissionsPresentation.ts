import type { api } from "@code2create/backend/api";
import {
  applicationDecisionLabels,
  applicationStateLabels,
  studyYearLabels,
  type AdmissionRecommendationState,
  type AdmissionReviewAssignmentState,
  type ApplicationDecision,
  type ParticipantClass,
  type StudyYear,
} from "@code2create/domain";
import type { FunctionArgs, FunctionReturnType } from "convex/server";

export type RecommendationFilter = NonNullable<FunctionArgs<typeof api.admissions.list>["recommendationFilter"]>;
export const recommendationOutcomeLabels: Record<RecommendationFilter["outcome"], string> = {
  accepted: "Accepted",
  waitlisted: "Waitlisted",
  rejected: "Rejected",
  unavailable: "No current recommendation",
  split: "Split reviews",
  needed: "Reviews needed",
};
export function recommendationFilterLabel(filter: RecommendationFilter) {
  return `${filter.source === "idea" ? "Idea agent" : "Human reviews"} · ${recommendationOutcomeLabels[filter.outcome]}`;
}

type ApplicationPage = FunctionReturnType<typeof api.admissions.list>;
export type QueueApplication = ApplicationPage["page"][number];
type AssignmentPage = FunctionReturnType<typeof api.admissions.myReviewAssignments>;
export type QueueAssignment = AssignmentPage["page"][number];
export type StageCount = FunctionReturnType<typeof api.admissions.stageCounts>[number];
export type ApplicationQueueStage = StageCount["state"];
export const applicationQueueStageLabels: Record<ApplicationQueueStage, string> = {
  ...applicationStateLabels,
  submitted: "Not started",
  under_review: "Review started",
  recorded: "Recorded decisions",
};
export const reviewProgresses = ["unreviewed", "partial", "complete"] as const;
export type ReviewProgress = (typeof reviewProgresses)[number];
export type ReviewProgressCounts = FunctionReturnType<typeof api.admissions.reviewProgressCounts>;
export const reviewProgressLabels: Record<ReviewProgress, string> = {
  unreviewed: "No reviews",
  partial: "Partially reviewed",
  complete: "Review minimum met",
};
export type ReviewAssignmentCounts = { active: number; completed: number };
export type ReviewerWorkload = FunctionReturnType<typeof api.admissions.reviewerWorkload>[number];
export type RosterCohortMember = { participantClass: ParticipantClass; yearOfStudy: StudyYear };
export type ReviewStatusTone = "done" | "waiting" | "unassigned";
export type AiStateTagTone = "accept" | "waitlist" | "decline" | "neutral";
export type AssignmentOutcome = { teamName: string; ok: boolean; message?: string };
export const teamOriginFilters = ["all", "internal", "external"] as const;
export type TeamOriginFilter = (typeof teamOriginFilters)[number];
export const teamOriginFilterLabels: Record<TeamOriginFilter, string> = {
  all: "All",
  internal: "Internals",
  external: "Externals",
};

export function teamOriginQueryArgs(origin: TeamOriginFilter): {
  origin?: "internal" | "external";
} {
  return origin === "all" ? {} : { origin };
}

export function teamOriginNoun(origin: TeamOriginFilter, plural = true): string {
  if (origin === "internal") return plural ? "internal teams" : "internal team";
  if (origin === "external") return plural ? "external teams" : "external team";
  return plural ? "teams" : "team";
}

export type VersionedReviewAssignment = {
  applicationContentVersion: number;
  state: AdmissionReviewAssignmentState;
};

export const applicationStageOrder: readonly ApplicationQueueStage[] = [
  "submitted",
  "under_review",
  "recorded",
  "accepted",
  "offer_sent",
  "confirmed",
  "waitlisted",
  "declined",
  "offer_expired",
  "withdrawn",
];

/** The stages that still take ordinary reviews and assignments. */
export function stageAcceptsReviews(state: ApplicationQueueStage) {
  return state === "submitted" || state === "under_review";
}

export function stageCountMap(counts: readonly StageCount[]) {
  return new Map<ApplicationQueueStage, number>(counts.map((row) => [row.state, row.count]));
}

/** Keep recorded decisions discoverable even before the first decision is saved. */
export function visibleStages(
  counts: ReadonlyMap<ApplicationQueueStage, number>,
  selected: ApplicationQueueStage | null,
): ApplicationQueueStage[] {
  return applicationStageOrder.filter(
    (stage) => stage === "recorded" || stage === selected || (counts.get(stage) ?? 0) > 0,
  );
}

export function parseApplicationStage(value: string): ApplicationQueueStage {
  return applicationStageOrder.find((stage) => stage === value) ?? "submitted";
}

export function reviewProgressLeadSentence(
  counts: ReviewProgressCounts,
  origin: TeamOriginFilter = "all",
): string {
  if (counts.total === 0) {
    return origin === "all"
      ? "No team has applied yet."
      : `No ${teamOriginNoun(origin, false)} has applied yet.`;
  }
  return `${counts.unreviewed} without a review, ${counts.partial} partially reviewed and ${counts.complete} at the review minimum.`;
}

export function reviewerLeadSentence(
  counts: ReviewAssignmentCounts | undefined,
  origin: TeamOriginFilter = "all",
): string {
  if (counts === undefined) return "";
  if (counts.active === 0 && counts.completed === 0) {
    return origin === "all"
      ? "Nothing is assigned to you yet. A coordinator hands out applications from the full list."
      : `No ${teamOriginNoun(origin)} are assigned to you.`;
  }
  if (counts.active === 0) return `Nothing left to review. ${counts.completed} done.`;
  return `${counts.active} ${counts.active === 1 ? "application" : "applications"} to review, ${counts.completed} done. Open assignments expire after 30 minutes.`;
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
  const reviews =
    completed > minimum
      ? `${completed} reviews submitted (${minimum} required)`
      : `${completed} of ${minimum} ${minimum === 1 ? "review" : "reviews"} in`;
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

export function reviewAssignmentSummary(
  assignments: readonly VersionedReviewAssignment[],
  currentContentVersion: number,
): string {
  const currentAssignments = assignments.filter(
    (assignment) =>
      assignment.applicationContentVersion === currentContentVersion &&
      assignment.state !== "cancelled",
  );
  const owing = currentAssignments.filter((assignment) => assignment.state === "active").length;
  if (currentAssignments.length === 0) {
    return `No one is assigned to application version ${currentContentVersion}.`;
  }
  if (owing === 0) {
    return `Every review assigned on application version ${currentContentVersion} has been submitted.`;
  }
  if (currentAssignments.length === 1) {
    return `1 reviewer assigned to application version ${currentContentVersion} still owes a review.`;
  }
  return `${owing} of ${currentAssignments.length} reviewers assigned to application version ${currentContentVersion} still owe a review.`;
}

export function reviewAssignmentStatusLine(
  assignment: VersionedReviewAssignment,
  currentContentVersion: number,
): string {
  const status = {
    active: "Review due",
    completed: "Review submitted",
    cancelled: "Assignment cancelled",
  }[assignment.state];
  const current =
    assignment.applicationContentVersion === currentContentVersion ? " (current)" : "";
  return `${status} on application version ${assignment.applicationContentVersion}${current}`;
}

function joinClauses(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1) ?? ""}`;
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** A claim does not complete work; keep the row prioritized until enough reviews are submitted. */
export function needsReview(application: {
  completedReviewCount: number;
  minimumHumanReviews: number;
}) {
  return application.completedReviewCount < application.minimumHumanReviews;
}

export function prioritizeReviewQueue<
  Application extends {
    completedReviewCount: number;
    minimumHumanReviews: number;
    submittedAt: number;
  },
>(applications: readonly Application[]): Application[] {
  return [...applications].sort((left, right) => {
    const byNeed = Number(needsReview(right)) - Number(needsReview(left));
    if (byNeed !== 0) return byNeed;
    const byCompletedReviews = left.completedReviewCount - right.completedReviewCount;
    return byCompletedReviews || left.submittedAt - right.submittedAt;
  });
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

import assert from "node:assert/strict";
import test from "node:test";

import {
  aiStateTag,
  applicationQueueStageLabels,
  assignmentOutcomeSummary,
  canAssignApplicationReview,
  cohortSummary,
  memberContextLine,
  needsReview,
  nextAssignmentId,
  ownReviewLine,
  prioritizeReviewQueue,
  remainingAssignmentsLine,
  reviewAssignmentStatusLine,
  reviewAssignmentSummary,
  reviewProgressLeadSentence,
  reviewStatus,
  reviewerLeadSentence,
  reviewerWorkloadLabel,
  stageCountMap,
  stageAcceptsReviews,
  teamLine,
  teamOriginNoun,
  teamOriginQueryArgs,
  visibleStages,
} from "./admissionsPresentation.ts";
import { queuePageBounds } from "./useQueuePagination.ts";

const vit = (
  yearOfStudy:
    | "first"
    | "second"
    | "third"
    | "fourth"
    | "fifth_or_later"
    | "postgraduate"
    | "not_applicable",
) => ({ participantClass: "vit_student" as const, yearOfStudy });
const external = {
  participantClass: "external_participant" as const,
  yearOfStudy: "not_applicable" as const,
};

test("a team is described by the years its members are actually in", () => {
  assert.equal(cohortSummary([vit("first"), vit("first")]), "First year");
  assert.equal(cohortSummary([vit("second")]), "Second year");
  assert.equal(cohortSummary([vit("fourth"), vit("fourth")]), "Fourth year");
  assert.equal(cohortSummary([vit("fifth_or_later")]), "Fifth year or later");
  assert.equal(cohortSummary([vit("first"), vit("second")]), "First and second year");
  assert.equal(
    cohortSummary([vit("second"), vit("third"), vit("fourth")]),
    "Second, third and fourth year",
  );
  assert.equal(cohortSummary([external, external]), "External");
  assert.equal(cohortSummary([vit("third"), external]), "Third year, external");
  assert.equal(cohortSummary([vit("postgraduate"), vit("fourth")]), "Fourth year, postgraduate");
  assert.equal(cohortSummary([]), "");
});

test("the team line keeps the member count even without profile access", () => {
  assert.equal(teamLine(4, [vit("second"), vit("second")]), "4 members · Second year");
  assert.equal(teamLine(1, undefined), "1 member");
  assert.equal(
    memberContextLine({ ...vit("third"), institution: "VIT Vellore" }),
    "Third year · VIT Vellore",
  );
  assert.equal(
    memberContextLine({ ...external, institution: "IIT Madras" }),
    "External participant · IIT Madras",
  );
});

test("review status says how many reviews are in and whether anyone is on it", () => {
  assert.deepEqual(
    reviewStatus({ completedReviewCount: 2, assignedReviewCount: 0, minimumHumanReviews: 2 }),
    { text: "2 of 2 reviews in", tone: "done" },
  );
  assert.deepEqual(
    reviewStatus({ completedReviewCount: 1, assignedReviewCount: 1, minimumHumanReviews: 2 }),
    { text: "1 of 2 reviews in · 1 assigned", tone: "waiting" },
  );
  assert.deepEqual(
    reviewStatus({ completedReviewCount: 0, assignedReviewCount: 0, minimumHumanReviews: 1 }),
    { text: "0 of 1 review in · nobody assigned", tone: "unassigned" },
  );
  assert.deepEqual(
    reviewStatus({ completedReviewCount: 3, assignedReviewCount: 0, minimumHumanReviews: 2 }),
    { text: "3 reviews submitted (2 required)", tone: "done" },
  );
});

test("stage chips keep recorded decisions discoverable beside the review stages", () => {
  const counts = stageCountMap([
    { state: "submitted", count: 18 },
    { state: "waitlisted", count: 2 },
  ]);
  assert.deepEqual(visibleStages(counts, "submitted"), ["submitted", "recorded", "waitlisted"]);
  assert.deepEqual(visibleStages(counts, "confirmed"), [
    "submitted",
    "recorded",
    "confirmed",
    "waitlisted",
  ]);
  assert.equal(applicationQueueStageLabels.submitted, "Not started");
  assert.equal(applicationQueueStageLabels.under_review, "Review started");
  assert.equal(applicationQueueStageLabels.recorded, "Recorded decisions");
  assert.equal(stageAcceptsReviews("recorded"), false);
});

test("queue pages stay bounded and return to the last page when live results shrink", () => {
  assert.deepEqual(queuePageBounds(0, 65, true), { page: 0, start: 0, end: 30 });
  assert.deepEqual(queuePageBounds(1, 65, true), { page: 1, start: 30, end: 60 });
  assert.deepEqual(queuePageBounds(2, 65, true), { page: 2, start: 60, end: 65 });
  assert.deepEqual(queuePageBounds(2, 60, true), { page: 1, start: 30, end: 60 });
  assert.deepEqual(queuePageBounds(1, 30, false), { page: 1, start: 30, end: 30 });
  assert.deepEqual(queuePageBounds(1, 30, true), { page: 0, start: 0, end: 30 });
  assert.deepEqual(queuePageBounds(2, 0, true), { page: 0, start: 0, end: 0 });
});

test("the queue summary reports mutually exclusive review coverage", () => {
  assert.equal(
    reviewProgressLeadSentence({ total: 0, unreviewed: 0, partial: 0, complete: 0 }, "internal"),
    "No internal team has applied yet.",
  );
  assert.equal(
    reviewProgressLeadSentence({ total: 0, unreviewed: 0, partial: 0, complete: 0 }, "external"),
    "No external team has applied yet.",
  );
  assert.equal(
    reviewProgressLeadSentence({ total: 22, unreviewed: 18, partial: 3, complete: 1 }),
    "18 without a review, 3 partially reviewed and 1 at the review minimum.",
  );
  assert.equal(
    reviewProgressLeadSentence(
      { total: 7, unreviewed: 0, partial: 0, complete: 7 },
      "internal",
    ),
    "0 without a review, 0 partially reviewed and 7 at the review minimum.",
  );
  assert.equal(
    reviewerLeadSentence({ active: 6, completed: 12 }),
    "6 applications to review, 12 done. Open assignments expire after 30 minutes.",
  );
  assert.equal(
    reviewerLeadSentence({ active: 0, completed: 12 }),
    "Nothing left to review. 12 done.",
  );
  assert.equal(
    reviewerLeadSentence({ active: 0, completed: 0 }),
    "Nothing is assigned to you yet. A coordinator hands out applications from the full list.",
  );
  assert.equal(
    reviewerLeadSentence({ active: 0, completed: 0 }, "internal"),
    "No internal teams are assigned to you.",
  );
});

test("the origin filter omits its query argument until internals or externals are chosen", () => {
  assert.deepEqual(teamOriginQueryArgs("all"), {});
  assert.deepEqual(teamOriginQueryArgs("internal"), { origin: "internal" });
  assert.deepEqual(teamOriginQueryArgs("external"), { origin: "external" });
  assert.equal(teamOriginNoun("all"), "teams");
  assert.equal(teamOriginNoun("internal", false), "internal team");
  assert.equal(teamOriginNoun("external"), "external teams");
});

test("short tags replace the AI sentences in the list", () => {
  assert.equal(aiStateTag(undefined), null);
  assert.equal(aiStateTag("disabled"), null);
  assert.deepEqual(aiStateTag("running"), {
    text: "Idea agent · Preparing",
    tone: "neutral",
  });
  assert.deepEqual(aiStateTag("succeeded", "accept"), {
    text: "Idea agent · Accept",
    tone: "accept",
  });
  assert.deepEqual(aiStateTag("succeeded", "waitlist"), {
    text: "Idea agent · Waitlist",
    tone: "waitlist",
  });
  assert.deepEqual(aiStateTag("succeeded", "decline"), {
    text: "Idea agent · Do not select",
    tone: "decline",
  });
  assert.deepEqual(aiStateTag("stale"), {
    text: "Idea agent · Out of date",
    tone: "neutral",
  });
  assert.deepEqual(aiStateTag("failed"), {
    text: "Idea agent · Unavailable",
    tone: "neutral",
  });
});

test("a reviewer sees what they said and where to go next", () => {
  assert.deepEqual(ownReviewLine({}), { text: "Not reviewed yet", done: false });
  assert.deepEqual(ownReviewLine({ ownRecommendation: "decline" }), {
    text: "You said do not select",
    done: true,
  });
  assert.equal(nextAssignmentId([{ applicationId: "a" }, { applicationId: "b" }], "a"), "b");
  assert.equal(nextAssignmentId([{ applicationId: "a" }], "a"), null);
});

test("bulk assignment reports what landed and what did not", () => {
  assert.equal(
    assignmentOutcomeSummary(
      [
        { teamName: "A", ok: true },
        { teamName: "B", ok: false, message: "x" },
      ],
      "priya@vit.ac.in",
    ),
    "Assigned 1 application to priya@vit.ac.in. 1 could not be assigned.",
  );
  assert.equal(
    assignmentOutcomeSummary(
      [
        { teamName: "A", ok: true },
        { teamName: "B", ok: true },
      ],
      "p@x",
    ),
    "Assigned 2 applications to p@x.",
  );
});

test("review assignment copy keeps every submitted application version visible", () => {
  const assignments = [
    { applicationContentVersion: 1, state: "completed" as const },
    { applicationContentVersion: 2, state: "active" as const },
    { applicationContentVersion: 2, state: "cancelled" as const },
  ];

  assert.equal(
    reviewAssignmentSummary(assignments, 2),
    "1 reviewer assigned to application version 2 still owes a review.",
  );
  assert.equal(
    reviewAssignmentStatusLine(assignments[0]!, 2),
    "Review submitted on application version 1",
  );
  assert.equal(
    reviewAssignmentStatusLine(assignments[1]!, 2),
    "Review due on application version 2 (current)",
  );
  assert.equal(
    reviewAssignmentStatusLine(assignments[2]!, 2),
    "Assignment cancelled on application version 2 (current)",
  );
  assert.equal(
    reviewAssignmentSummary([{ applicationContentVersion: 1, state: "completed" }], 2),
    "No one is assigned to application version 2.",
  );
  assert.equal(
    reviewAssignmentSummary([{ applicationContentVersion: 2, state: "completed" }], 2),
    "Every review assigned on application version 2 has been submitted.",
  );
});

test("unfinished reviews stay prioritized even while assigned", () => {
  assert.equal(
    needsReview({ completedReviewCount: 0, minimumHumanReviews: 2 }),
    true,
  );
  assert.equal(
    needsReview({ completedReviewCount: 1, minimumHumanReviews: 2 }),
    true,
  );
  const claimed = {
    assignedReviewCount: 1,
    completedReviewCount: 0,
    minimumHumanReviews: 2,
  };
  assert.equal(needsReview(claimed), true);
  assert.equal(
    needsReview({ completedReviewCount: 2, minimumHumanReviews: 2 }),
    false,
  );
  const prioritized = prioritizeReviewQueue([
    { id: "done", completedReviewCount: 2, minimumHumanReviews: 2, submittedAt: 1 },
    { id: "claimed", completedReviewCount: 0, minimumHumanReviews: 2, submittedAt: 3 },
    { id: "partly-reviewed", completedReviewCount: 1, minimumHumanReviews: 2, submittedAt: 2 },
  ]);
  assert.deepEqual(
    prioritized.map((application) => application.id),
    ["claimed", "partly-reviewed", "done"],
  );
});

test("only applications with remaining review coverage can be assigned", () => {
  for (const state of ["submitted", "under_review"] as const) {
    assert.equal(canAssignApplicationReview({ state, completedReviewCount: 0, minimumHumanReviews: 2 }), true);
    assert.equal(canAssignApplicationReview({ state, completedReviewCount: 1, minimumHumanReviews: 2 }), true);
    assert.equal(canAssignApplicationReview({ state, completedReviewCount: 1, minimumHumanReviews: 1 }), false);
    assert.equal(canAssignApplicationReview({ state, completedReviewCount: 2, minimumHumanReviews: 2 }), false);
    assert.equal(canAssignApplicationReview({ state, completedReviewCount: 3, minimumHumanReviews: 2 }), false);
  }
  for (const state of ["accepted", "offer_sent", "confirmed", "waitlisted", "declined", "offer_expired", "withdrawn"] as const) {
    assert.equal(canAssignApplicationReview({ state, completedReviewCount: 0, minimumHumanReviews: 2 }), false);
  }
});

test("reviewer workload is readable at a glance", () => {
  assert.equal(reviewerWorkloadLabel({ active: 4, completed: 2 }), "4 open");
  assert.equal(reviewerWorkloadLabel({ active: 0, completed: 7 }), "7 done");
  assert.equal(
    remainingAssignmentsLine({ active: 4, completed: 1 }),
    "4 more are assigned to you.",
  );
  assert.equal(remainingAssignmentsLine({ active: 1, completed: 1 }), "1 more is assigned to you.");
  assert.equal(remainingAssignmentsLine({ active: 0, completed: 3 }), null);
  assert.equal(remainingAssignmentsLine(undefined), null);
});

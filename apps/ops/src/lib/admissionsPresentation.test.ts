import assert from "node:assert/strict";
import test from "node:test";

import {
  aiStateTag,
  assignmentOutcomeSummary,
  busiestStage,
  cohortSummary,
  completedReviewCountQueryArgs,
  memberContextLine,
  needsAssignment,
  nextAssignmentId,
  ownReviewLine,
  queueLeadSentence,
  remainingAssignmentsLine,
  reviewAssignmentStatusLine,
  reviewAssignmentSummary,
  reviewStatus,
  reviewerLeadSentence,
  reviewerWorkloadLabel,
  stageCountMap,
  teamLine,
  teamOriginNoun,
  teamOriginQueryArgs,
  visibleStages,
} from "./admissionsPresentation.ts";

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
});

test("stage chips only show stages with something in them", () => {
  const counts = stageCountMap([
    { state: "submitted", count: 18 },
    { state: "waitlisted", count: 2 },
  ]);
  assert.equal(busiestStage(counts), "submitted");
  assert.deepEqual(visibleStages(counts, "submitted"), ["submitted", "waitlisted"]);
  assert.deepEqual(visibleStages(counts, "confirmed"), [
    "submitted",
    "confirmed",
    "waitlisted",
  ]);
  assert.equal(busiestStage(new Map()), null);
});

test("the queue opens with one sentence about where applications are", () => {
  assert.equal(queueLeadSentence(new Map()), "No team has applied yet.");
  assert.equal(queueLeadSentence(new Map(), "all", true), "No team has exactly 1 review in.");
  assert.equal(
    queueLeadSentence(new Map(), "internal"),
    "No internal team has applied yet.",
  );
  assert.equal(
    queueLeadSentence(new Map(), "external"),
    "No external team has applied yet.",
  );
  assert.equal(
    queueLeadSentence(
      stageCountMap([
        { state: "submitted", count: 18 },
        { state: "under_review", count: 3 },
        { state: "waitlisted", count: 1 },
      ]),
    ),
    "18 need a first review and 3 are being reviewed.",
  );
  assert.equal(
    queueLeadSentence(
      stageCountMap([
        { state: "confirmed", count: 5 },
        { state: "declined", count: 2 },
      ]),
    ),
    "7 applications, all decided.",
  );
  assert.equal(
    reviewerLeadSentence({ active: 6, completed: 12 }),
    "6 applications to review, 12 done.",
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

test("the one-review filter only sends its exact count when selected", () => {
  assert.deepEqual(completedReviewCountQueryArgs(false), {});
  assert.deepEqual(completedReviewCountQueryArgs(true), { completedReviewCount: 1 });
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

test("coordinators can pull out the rows nobody is on, and read reviewer workload at a glance", () => {
  assert.equal(
    needsAssignment({ completedReviewCount: 0, assignedReviewCount: 0, minimumHumanReviews: 2 }),
    true,
  );
  assert.equal(
    needsAssignment({ completedReviewCount: 1, assignedReviewCount: 0, minimumHumanReviews: 2 }),
    true,
  );
  assert.equal(
    needsAssignment({ completedReviewCount: 0, assignedReviewCount: 1, minimumHumanReviews: 2 }),
    false,
  );
  assert.equal(
    needsAssignment({ completedReviewCount: 2, assignedReviewCount: 0, minimumHumanReviews: 2 }),
    false,
  );
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

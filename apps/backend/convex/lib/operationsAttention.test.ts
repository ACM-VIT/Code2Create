import assert from "node:assert/strict";
import test from "node:test";

import { reviewAttentionRows, sortAttentionRows } from "./operationsAttention.ts";

const minute = 60 * 1_000;
const now = 1_770_000_000_000;

function board(
  overrides: Partial<Parameters<typeof reviewAttentionRows>[0]> = {},
): Parameters<typeof reviewAttentionRows>[0] {
  return {
    roundId: "round1",
    roundName: "Review 1",
    requiredPanelSize: 3,
    reviewDurationSeconds: 600,
    panels: [],
    teams: [],
    now,
    ...overrides,
  };
}

function team(
  overrides: Partial<Parameters<typeof reviewAttentionRows>[0]["teams"][number]> = {},
): Parameters<typeof reviewAttentionRows>[0]["teams"][number] {
  return {
    teamName: "Nightshift",
    state: "queued",
    canHold: true,
    canResume: true,
    canMarkMissed: true,
    participantAvailability: {
      availableCount: 4,
      requiredCount: 2,
      isMet: true,
      isWaived: false,
      canWaive: true,
    },
    review: null,
    ...overrides,
  };
}

test("a healthy floor produces no rows", () => {
  assert.deepEqual(reviewAttentionRows(board({ teams: [team()] })), []);
});

test("an empty panel seat names the panel and its table", () => {
  const rows = reviewAttentionRows(
    board({
      panels: [
        {
          id: "p1",
          name: "Panel D",
          tableLabel: "Table 4",
          status: "needs_reviewer",
          reviewers: [
            { displayName: "Asha", clockInStatus: "present" },
            { displayName: "Ben", clockInStatus: "present" },
          ],
        },
      ],
    }),
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.subject, "Panel D · Table 4");
  assert.equal(rows[0]?.severity, "critical");
  assert.match(rows[0]?.statement ?? "", /One seat/);
  assert.equal(rows[0]?.route, "/reviews/round1");
});

test("a reviewer who is clocked in but away still leaves the seat empty", () => {
  const rows = reviewAttentionRows(
    board({
      panels: [
        {
          id: "p1",
          name: "Panel A",
          tableLabel: "Table 1",
          status: "ready",
          reviewers: [
            { displayName: "Asha", clockInStatus: "present" },
            { displayName: "Ben", clockInStatus: "present" },
            { displayName: "Cal", clockInStatus: "temporarily_unavailable" },
          ],
        },
      ],
    }),
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.subject, "Panel A · Table 1");
});

test("an overdue review is critical and carries the time it should have ended", () => {
  const plannedEndAt = now - 6 * minute;
  const rows = reviewAttentionRows(
    board({
      teams: [
        team({
          state: "in_review",
          tableLabel: "Table 2",
          review: {
            status: "overdue",
            plannedEndAt,
            reviewerPresenceCount: 3,
            reviewerCount: 3,
            canStart: false,
            canComplete: true,
          },
        }),
      ],
    }),
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.severity, "critical");
  assert.equal(rows[0]?.subject, "Nightshift");
  assert.equal(rows[0]?.context, "Review 1 · Table 2");
  assert.equal(rows[0]?.since, plannedEndAt);
});

test("a team below the round minimum says the actual counts", () => {
  const rows = reviewAttentionRows(
    board({
      teams: [
        team({
          participantAvailability: {
            availableCount: 1,
            requiredCount: 2,
            isMet: false,
            isWaived: false,
            canWaive: true,
          },
        }),
      ],
    }),
  );
  assert.equal(rows.length, 1);
  assert.match(rows[0]?.statement ?? "", /Only 1 .* needs 2/);
});

test("a waived team below the minimum is not still reported", () => {
  const rows = reviewAttentionRows(
    board({
      teams: [
        team({
          participantAvailability: {
            availableCount: 1,
            requiredCount: 2,
            isMet: false,
            isWaived: true,
            canWaive: true,
          },
        }),
      ],
    }),
  );
  assert.deepEqual(rows, []);
});

test("a held team shows the reason the operator recorded", () => {
  const rows = reviewAttentionRows(
    board({
      teams: [team({ state: "held", holdReason: "Two members are at the clinic." })],
    }),
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.statement, "On hold: Two members are at the clinic.");
});

test("waiting is only flagged past two reviews' worth of time", () => {
  const justUnder = reviewAttentionRows(
    board({ teams: [team({ queuedAt: now - 19 * minute })] }),
  );
  assert.deepEqual(justUnder, []);

  const justOver = reviewAttentionRows(
    board({ teams: [team({ queuedAt: now - 21 * minute })] }),
  );
  assert.equal(justOver.length, 1);
  assert.equal(justOver[0]?.severity, "watch");
});

test("canAct is false when the caller cannot run the fix", () => {
  const rows = reviewAttentionRows(
    board({
      teams: [
        team({
          state: "held",
          holdReason: "Waiting on a part.",
          canResume: false,
        }),
      ],
    }),
  );
  assert.equal(rows[0]?.canAct, false);
});

test("rows sort worst first, then longest waiting", () => {
  const rows = sortAttentionRows([
    { key: "c", job: "team_queue", severity: "watch", subject: "C", statement: "", route: "/", actionLabel: "", canAct: true },
    { key: "a", job: "active_reviews", severity: "critical", subject: "A", statement: "", route: "/", actionLabel: "", canAct: true, since: now },
    { key: "b", job: "active_reviews", severity: "critical", subject: "B", statement: "", route: "/", actionLabel: "", canAct: true, since: now - minute },
  ]);
  assert.deepEqual(
    rows.map((row) => row.key),
    ["b", "a", "c"],
  );
});

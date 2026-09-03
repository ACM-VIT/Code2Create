import assert from "node:assert/strict";
import test from "node:test";

import type { AttentionCommand } from "./operationsAttentionProposals";

import {
  reviewFloorItems,
  roundForecastItems,
  scorecardChaseItems,
  type PanelMemberProjection,
  type PanelProjection,
  type ReviewFloorProjection,
  type TeamProjection,
} from "./operationsAttentionDetectors.ts";

const minute = 60 * 1_000;
const now = 1_770_000_000_000;

function floor(overrides: Partial<ReviewFloorProjection> = {}): ReviewFloorProjection {
  return {
    now,
    roundId: "round1",
    roundName: "Review 1",
    roundEndsAt: now + 60 * minute,
    reviewerReportAt: now - 10 * minute,
    reviewerNoShowGraceSeconds: 180,
    requiredPanelSize: 3,
    reviewDurationSeconds: 600,
    isPaused: false,
    panels: [],
    teams: [],
    ...overrides,
  };
}

function member(overrides: Partial<PanelMemberProjection> = {}): PanelMemberProjection {
  return {
    panelMemberId: "m1",
    personId: "person1",
    displayName: "Asha",
    clockInStatus: "present",
    clockInVersion: 3,
    lastHeartbeatAt: now - 20_000,
    deviceCount: 1,
    pushTokenStatus: "active",
    ...overrides,
  };
}

function panel(overrides: Partial<PanelProjection> = {}): PanelProjection {
  return {
    panelId: "p1",
    name: "Panel D",
    status: "ready",
    version: 4,
    statusSince: now - 30 * minute,
    hasActivePageChain: false,
    hasRunningReview: false,
    members: [
      member(),
      member({ panelMemberId: "m2", personId: "person2", displayName: "Ben" }),
      member({ panelMemberId: "m3", personId: "person3", displayName: "Cal" }),
    ],
    queuedTeams: [],
    completedDurationsSeconds: [],
    ...overrides,
  };
}

function team(overrides: Partial<TeamProjection> = {}): TeamProjection {
  return {
    teamRoundStateId: "s1",
    version: 2,
    teamId: "t1",
    teamName: "Nightshift",
    panelId: "p1",
    state: "queued",
    updatedAt: now - minute,
    availableCount: 4,
    requiredCount: 2,
    availabilityWaived: false,
    review: null,
    ...overrides,
  };
}

function only(items: ReturnType<typeof reviewFloorItems>, key: string) {
  return items.filter((item) => item.detectorKey === key);
}

function commandField(command: AttentionCommand | undefined, field: string) {
  if (command === undefined) return undefined;
  const entries: Record<string, unknown> = { ...command };
  return entries[field];
}

test("a full, quiet panel produces nothing", () => {
  assert.deepEqual(reviewFloorItems(floor({ panels: [panel()], teams: [team()] })), []);
});

test("a short panel names the panel and the queue behind it", () => {
  const queuedTeams = [
    { teamRoundStateId: "s1", version: 1, teamName: "Nightshift", queuedAt: now },
    { teamRoundStateId: "s2", version: 1, teamName: "Kite", queuedAt: now },
  ];
  const items = reviewFloorItems(
    floor({
      panels: [
        panel({
          members: [member(), member({ panelMemberId: "m2", personId: "p2" })],
          queuedTeams,
        }),
      ],
      teams: [team(), team({ teamRoundStateId: "s2", teamId: "t2", teamName: "Kite" })],
    }),
  );
  const seat = only(items, "panel_seat_empty");
  assert.equal(seat.length, 1);
  assert.equal(seat[0]?.severity, "critical");
  assert.equal(seat[0]?.subjectId, "p1");
  assert.match(seat[0]?.statement ?? "", /Panel D is short one reviewer, and 2 teams are queued/);
});

test("a seat empty for less than a minute is an ordinary swap, not an item", () => {
  const items = reviewFloorItems(
    floor({
      panels: [
        panel({
          status: "needs_reviewer",
          statusSince: now - 30_000,
          members: [member(), member({ panelMemberId: "m2", personId: "p2" })],
        }),
      ],
    }),
  );
  assert.deepEqual(only(items, "panel_seat_empty"), []);
});

test("draft and closed panels are never reported as short", () => {
  const items = reviewFloorItems(
    floor({
      panels: [
        panel({ panelId: "draft", status: "draft", members: [] }),
        panel({ panelId: "closed", status: "closed", members: [] }),
      ],
    }),
  );
  assert.deepEqual(items, []);
});

test("a vacancy carries a prefilled substitute page, with the panel version", () => {
  const items = reviewFloorItems(
    floor({
      panels: [
        panel({
          status: "needs_reviewer",
          vacantPanelMemberId: "gone",
          members: [member(), member({ panelMemberId: "m2", personId: "p2" })],
          queuedTeams: [
            { teamRoundStateId: "s1", version: 1, teamName: "Nightshift", queuedAt: now },
          ],
        }),
      ],
      teams: [team()],
    }),
  );
  const proposal = only(items, "panel_seat_empty")[0]?.proposal;
  assert.equal(proposal?.command.name, "reviewSubstitutions.startPageChain");
  assert.equal(proposal?.permissionKey, "review.substitute.page");
  assert.equal(proposal?.scopeType, "panel");
  assert.deepEqual(proposal?.command, {
    name: "reviewSubstitutions.startPageChain",
    missingPanelMemberId: "gone",
    expectedPanelVersion: 4,
    reason: "Panel D is short one reviewer with one team queued.",
  });
});

test("no page is proposed while a page chain is already running", () => {
  const items = reviewFloorItems(
    floor({
      panels: [
        panel({
          status: "needs_reviewer",
          vacantPanelMemberId: "gone",
          hasActivePageChain: true,
          members: [member(), member({ panelMemberId: "m2", personId: "p2" })],
        }),
      ],
    }),
  );
  assert.equal(only(items, "panel_seat_empty")[0]?.proposal, undefined);
  assert.equal(only(items, "panel_seat_empty")[0]?.actionLabel, "Open the panel");
});

test("a stale heartbeat is reported as a signal, never as proof", () => {
  const items = reviewFloorItems(
    floor({
      panels: [
        panel({
          members: [
            member({ lastHeartbeatAt: now - 7 * minute }),
            member({ panelMemberId: "m2", personId: "p2", displayName: "Ben" }),
            member({ panelMemberId: "m3", personId: "p3", displayName: "Cal" }),
          ],
          queuedTeams: [
            { teamRoundStateId: "s1", version: 2, teamName: "Nightshift", queuedAt: now - minute },
          ],
        }),
      ],
      teams: [team()],
    }),
  );
  const risk = only(items, "seat_at_risk");
  assert.equal(risk.length, 1);
  assert.equal(risk[0]?.severity, "attention");
  assert.match(risk[0]?.statement ?? "", /has not checked in for 7m/);
  assert.match(risk[0]?.statement ?? "", /a signal and not proof they left the table/);
  assert.match(risk[0]?.statement ?? "", /Confirm before freeing the seat/);
  assert.doesNotMatch(risk[0]?.statement ?? "", /venue|went home|has left/i);
  assert.equal(risk[0]?.proposal, undefined);
});

test("a seat is only at risk when teams are actually waiting on it", () => {
  const items = reviewFloorItems(
    floor({
      panels: [panel({ members: [member({ lastHeartbeatAt: now - 7 * minute })] })],
      teams: [team({ state: "completed" })],
    }),
  );
  assert.deepEqual(only(items, "seat_at_risk"), []);
});

test("a heartbeat inside the window is not a risk", () => {
  const items = reviewFloorItems(
    floor({
      panels: [
        panel({
          members: [
            member({ lastHeartbeatAt: now - 3 * minute }),
            member({ panelMemberId: "m2", personId: "p2" }),
            member({ panelMemberId: "m3", personId: "p3" }),
          ],
        }),
      ],
      teams: [team()],
    }),
  );
  assert.deepEqual(only(items, "seat_at_risk"), []);
});

test("a reviewer who has clocked out is the empty-seat story, not the at-risk one", () => {
  const items = reviewFloorItems(
    floor({
      panels: [
        panel({
          members: [
            member({ clockInStatus: "clocked_out", lastHeartbeatAt: now - 30 * minute }),
            member({ panelMemberId: "m2", personId: "p2" }),
            member({ panelMemberId: "m3", personId: "p3" }),
          ],
        }),
      ],
      teams: [team()],
    }),
  );
  assert.deepEqual(only(items, "seat_at_risk"), []);
  assert.equal(only(items, "panel_seat_empty").length, 1);
});

test("a late return names the time the reviewer gave, and proposes a confirmation", () => {
  const items = reviewFloorItems(
    floor({
      panels: [
        panel({
          members: [
            member({
              clockInStatus: "temporarily_unavailable",
              expectedReturnAt: now - 12 * minute,
            }),
            member({ panelMemberId: "m2", personId: "p2" }),
            member({ panelMemberId: "m3", personId: "p3" }),
            member({ panelMemberId: "m4", personId: "p4" }),
          ],
          queuedTeams: [
            { teamRoundStateId: "s1", version: 2, teamName: "Nightshift", queuedAt: now - minute },
          ],
        }),
      ],
      teams: [team()],
    }),
  );
  const risk = only(items, "seat_at_risk")[0];
  assert.match(risk?.statement ?? "", /12m past the time they gave for coming back/);
  assert.equal(risk?.proposal?.command.name, "reviewSubstitutions.markNoShow");
  assert.deepEqual(risk?.proposal?.command, {
    name: "reviewSubstitutions.markNoShow",
    panelMemberId: "m1",
    expectedPanelVersion: 4,
    expectedClockInVersion: 3,
    reason: "Asha is 12m past the return time they recorded.",
  });
});

test("a return time only just passed is inside the grace period", () => {
  const items = reviewFloorItems(
    floor({
      panels: [
        panel({
          members: [
            member({ clockInStatus: "temporarily_unavailable", expectedReturnAt: now - minute }),
            member({ panelMemberId: "m2", personId: "p2" }),
            member({ panelMemberId: "m3", personId: "p3" }),
            member({ panelMemberId: "m4", personId: "p4" }),
          ],
          queuedTeams: [
            { teamRoundStateId: "s1", version: 2, teamName: "Nightshift", queuedAt: now - minute },
          ],
        }),
      ],
      teams: [team()],
    }),
  );
  assert.deepEqual(only(items, "seat_at_risk"), []);
});

test("the exact published late-return boundary permits the no-show proposal", () => {
  const items = reviewFloorItems(
    floor({
      reviewerNoShowGraceSeconds: 90,
      panels: [
        panel({
          members: [
            member({
              clockInStatus: "temporarily_unavailable",
              expectedReturnAt: now - 90_000,
              lastHeartbeatAt: now - 10 * minute,
            }),
            member({ panelMemberId: "m2", personId: "p2" }),
            member({ panelMemberId: "m3", personId: "p3" }),
          ],
          queuedTeams: [
            { teamRoundStateId: "s1", version: 2, teamName: "Nightshift", queuedAt: now - minute },
          ],
        }),
      ],
    }),
  );
  assert.equal(
    only(items, "seat_at_risk")[0]?.proposal?.command.name,
    "reviewSubstitutions.markNoShow",
  );
});

test("an unreachable sole device is a risk; a spare device is not", () => {
  const unreachable = member({
    lastHeartbeatAt: now - minute,
    deviceCount: 1,
    pushTokenStatus: "invalid",
    pushTokenInvalidatedAt: now - 10 * minute,
  });
  const withSpare = { ...unreachable, deviceCount: 2 };
  const build = (first: PanelMemberProjection) =>
    reviewFloorItems(
      floor({
        panels: [
          panel({
            members: [
              first,
              member({ panelMemberId: "m2", personId: "p2" }),
              member({ panelMemberId: "m3", personId: "p3" }),
            ],
            queuedTeams: [
              {
                teamRoundStateId: "s1",
                version: 2,
                teamName: "Nightshift",
                queuedAt: now - minute,
              },
            ],
          }),
        ],
        teams: [team()],
      }),
    );
  assert.match(
    only(build(unreachable), "seat_at_risk")[0]?.statement ?? "",
    /only registered device stopped accepting pages/,
  );
  assert.deepEqual(only(build(withSpare), "seat_at_risk"), []);
});

test("no no-show is proposed while a review timer is running on that panel", () => {
  const items = reviewFloorItems(
    floor({
      panels: [
        panel({
          hasRunningReview: true,
          members: [
            member({ lastHeartbeatAt: now - 9 * minute }),
            member({ panelMemberId: "m2", personId: "p2" }),
            member({ panelMemberId: "m3", personId: "p3" }),
          ],
          queuedTeams: [
            { teamRoundStateId: "s1", version: 2, teamName: "Nightshift", queuedAt: now - minute },
          ],
        }),
      ],
      teams: [team()],
    }),
  );
  assert.equal(only(items, "seat_at_risk")[0]?.proposal, undefined);
});

test("an overdue review says how far past it is and offers the extension", () => {
  const items = reviewFloorItems(
    floor({
      panels: [panel()],
      teams: [
        team({
          state: "in_review",
          tableLabel: "Table 2",
          review: {
            reviewSessionId: "rev1",
            version: 5,
            status: "overdue",
            createdAt: now - 30 * minute,
            plannedEndAt: now - 6 * minute,
            reviewerPresenceCount: 3,
            reviewerCount: 3,
            canExtend: true,
          },
        }),
      ],
    }),
  );
  const overdue = only(items, "review_overdue")[0];
  assert.equal(overdue?.severity, "critical");
  assert.match(overdue?.statement ?? "", /Nightshift at Review 1 · Table 2 is 6m past/);
  assert.equal(overdue?.proposal?.command.name, "reviewOperations.extendReview");
  assert.equal(commandField(overdue?.proposal?.command, "expectedVersion"), 5);
});

test("a review out of extensions is reported without a proposal", () => {
  const items = reviewFloorItems(
    floor({
      panels: [panel()],
      teams: [
        team({
          state: "in_review",
          review: {
            reviewSessionId: "rev1",
            version: 5,
            status: "overdue",
            createdAt: now - 30 * minute,
            plannedEndAt: now - 6 * minute,
            reviewerPresenceCount: 3,
            reviewerCount: 3,
            canExtend: false,
          },
        }),
      ],
    }),
  );
  assert.equal(only(items, "review_overdue")[0]?.proposal, undefined);
  assert.equal(only(items, "review_overdue")[0]?.actionLabel, "Close it out");
});

test("reviewers still walking to the table are given three minutes", () => {
  const waiting = (createdAt: number) =>
    reviewFloorItems(
      floor({
        panels: [panel()],
        teams: [
          team({
            state: "at_table",
            review: {
              reviewSessionId: "rev1",
              version: 1,
              status: "awaiting_presence",
              createdAt,
              reviewerPresenceCount: 2,
              reviewerCount: 3,
              canExtend: true,
            },
          }),
        ],
      }),
    );
  assert.deepEqual(only(waiting(now - 2 * minute), "review_presence_incomplete"), []);
  assert.match(
    only(waiting(now - 5 * minute), "review_presence_incomplete")[0]?.statement ?? "",
    /2 of 3 reviewers have scanned in/,
  );
});

test("a team below the round minimum states the real counts", () => {
  const items = reviewFloorItems(
    floor({
      panels: [panel()],
      teams: [
        team({
          queuedAt: now - 10 * minute,
          availableCount: 1,
          requiredCount: 2,
        }),
      ],
    }),
  );
  assert.match(
    only(items, "team_below_minimum")[0]?.statement ?? "",
    /has 1 of the 2 people this round needs inside the hall/,
  );
});

test("a waived team below the minimum is not still reported", () => {
  const items = reviewFloorItems(
    floor({
      panels: [panel()],
      teams: [
        team({
          queuedAt: now - 10 * minute,
          availableCount: 1,
          requiredCount: 2,
          availabilityWaived: true,
        }),
      ],
    }),
  );
  assert.deepEqual(only(items, "team_below_minimum"), []);
});

test("a team that just arrived at the queue is not immediately short", () => {
  const items = reviewFloorItems(
    floor({
      panels: [panel()],
      teams: [team({ queuedAt: now - 30_000, availableCount: 1, requiredCount: 2 })],
    }),
  );
  assert.deepEqual(only(items, "team_below_minimum"), []);
});

test("a hold shows its reason once it has lasted, and offers the resume", () => {
  const held = (heldAt: number) =>
    reviewFloorItems(
      floor({
        panels: [panel()],
        teams: [
          team({
            state: "held",
            heldAt,
            holdReason: "Two members are at the clinic.",
          }),
        ],
      }),
    );
  assert.deepEqual(only(held(now - 2 * minute), "team_held"), []);
  const item = only(held(now - 9 * minute), "team_held")[0];
  assert.match(item?.statement ?? "", /on hold for 9m: Two members are at the clinic\./);
  assert.equal(item?.proposal?.command.name, "reviewExceptions.resumeTeam");
  assert.equal(commandField(item?.proposal?.command, "expectedVersion"), 2);
});

test("a call past its grace period offers the missed mark", () => {
  const items = reviewFloorItems(
    floor({
      panels: [panel()],
      teams: [
        team({
          state: "called",
          calledAt: now - 8 * minute,
          missedEligibleAt: now - 4 * minute,
        }),
      ],
    }),
  );
  const item = only(items, "team_call_overdue")[0];
  assert.match(item?.statement ?? "", /grace period ran out 4m ago/);
  assert.equal(item?.proposal?.command.name, "reviewExceptions.markMissed");
});

test("waiting is only flagged past two reviews' worth of time", () => {
  const waited = (queuedAt: number) =>
    reviewFloorItems(floor({ panels: [panel()], teams: [team({ queuedAt })] }));
  assert.deepEqual(only(waited(now - 19 * minute), "team_waiting_long"), []);
  const item = only(waited(now - 21 * minute), "team_waiting_long")[0];
  assert.equal(item?.severity, "watch");
  assert.match(item?.statement ?? "", /queued for 21m/);
});

test("a paused round stops the clock-driven rows but keeps the structural ones", () => {
  const paused = floor({
    isPaused: true,
    panels: [panel({ members: [member(), member({ panelMemberId: "m2", personId: "p2" })] })],
    teams: [
      team({ queuedAt: now - 40 * minute }),
      team({
        teamRoundStateId: "s2",
        teamId: "t2",
        state: "called",
        missedEligibleAt: now - 5 * minute,
      }),
    ],
  });
  const keys = reviewFloorItems(paused).map((item) => item.detectorKey);
  assert.deepEqual(keys, ["panel_seat_empty"]);
});

function pacedPanel(
  panelId: string,
  name: string,
  queued: number,
  durations: readonly number[],
): PanelProjection {
  return panel({
    panelId,
    name,
    queuedTeams: Array.from({ length: queued }, (_unused, index) => ({
      teamRoundStateId: `${panelId}-s${index}`,
      version: 1,
      teamName: `${name} team ${index}`,
      queuedAt: now - (queued - index) * minute,
    })),
    completedDurationsSeconds: durations,
  });
}

test("a forecast with too few completed reviews is the configured duration restated, so it is not reported", () => {
  const items = roundForecastItems(
    floor({
      roundEndsAt: now + 5 * minute,
      panels: [pacedPanel("p1", "Panel A", 20, [700, 720])],
    }),
  );
  assert.deepEqual(items, []);
});

test("a round that finishes inside its window is not reported", () => {
  const items = roundForecastItems(
    floor({
      roundEndsAt: now + 120 * minute,
      panels: [pacedPanel("p1", "Panel A", 5, [600, 610, 590, 600])],
    }),
  );
  assert.deepEqual(items, []);
});

test("an overrunning round states the pace, the panels, the teams, and the overrun", () => {
  const items = roundForecastItems(
    floor({
      roundEndsAt: now + 30 * minute,
      panels: [
        pacedPanel("p1", "Panel A", 7, [580, 600, 620]),
        pacedPanel("p2", "Panel B", 7, [580, 600, 620]),
      ],
    }),
  );
  const forecast = items.find((item) => item.detectorKey === "round_finish_forecast");
  assert.equal(forecast?.severity, "attention");
  assert.match(
    forecast?.statement ?? "",
    /At the current pace, 10m per review across 2 panels, the 14 remaining teams finish 40m after this round's window closes\./,
  );
  assert.equal(JSON.parse(forecast?.evidenceJson ?? "{}").remainingTeams, 14);
});

test("severity follows how far past the window the round lands", () => {
  const overrun = (queued: number) =>
    roundForecastItems(
      floor({
        roundEndsAt: now + 10 * minute,
        panels: [
          pacedPanel("p1", "Panel A", queued, [600, 600, 600]),
          pacedPanel("p2", "Panel B", queued, [600, 600, 600]),
        ],
      }),
    ).find((item) => item.detectorKey === "round_finish_forecast");
  assert.equal(overrun(3)?.severity, "watch");
  assert.equal(overrun(5)?.severity, "attention");
  assert.equal(overrun(8)?.severity, "critical");
});

test("the bottleneck panel is named and offered a move to the panel that finishes first", () => {
  const items = roundForecastItems(
    floor({
      roundEndsAt: now + 10 * minute,
      panels: [
        pacedPanel("p1", "Panel A", 1, [600, 600, 600]),
        pacedPanel("p2", "Panel B", 3, [600, 600, 600]),
        pacedPanel("p3", "Panel C", 9, [600, 600, 600]),
      ],
    }),
  );
  const bottleneck = items.find((item) => item.detectorKey === "panel_bottleneck");
  assert.equal(bottleneck?.subjectId, "p3");
  assert.match(bottleneck?.statement ?? "", /Panel C finishes 1h after the middle of the round/);
  assert.match(bottleneck?.statement ?? "", /Panel A finishes first/);
  assert.equal(bottleneck?.proposal?.command.name, "reviewExceptions.moveQueuedTeam");
  assert.equal(commandField(bottleneck?.proposal?.command, "targetPanelId"), "p1");
  assert.equal(commandField(bottleneck?.proposal?.command, "teamRoundStateId"), "p3-s8");
});

test("panels within a quarter hour of each other have no bottleneck", () => {
  const items = roundForecastItems(
    floor({
      roundEndsAt: now + 10 * minute,
      panels: [
        pacedPanel("p1", "Panel A", 4, [600, 600, 600]),
        pacedPanel("p2", "Panel B", 5, [600, 600, 600]),
        pacedPanel("p3", "Panel C", 5, [600, 600, 600]),
      ],
    }),
  );
  assert.deepEqual(
    items.filter((item) => item.detectorKey === "panel_bottleneck"),
    [],
  );
});

test("a paused round is not forecast at all", () => {
  assert.deepEqual(
    roundForecastItems(
      floor({
        isPaused: true,
        roundEndsAt: now - 60 * minute,
        panels: [pacedPanel("p1", "Panel A", 9, [600, 600, 600])],
      }),
    ),
    [],
  );
});

test("an outstanding scorecard names the reviewers and only what their app reported", () => {
  const items = scorecardChaseItems({
    now,
    roundId: "round1",
    roundName: "Review 1",
    sessions: [
      {
        reviewSessionId: "rev1",
        teamName: "Nightshift",
        panelName: "Panel D",
        completedAt: now - 14 * minute,
        reviewers: [
          { displayName: "Asha", clockInStatus: "present", lastHeartbeatAt: now - 2 * minute },
          { displayName: "Ben", clockInStatus: "present", lastHeartbeatAt: now - 21 * minute },
        ],
      },
    ],
  });
  assert.equal(items.length, 1);
  assert.equal(items[0]?.severity, "watch");
  assert.equal(
    items[0]?.statement,
    "Asha and Ben have not submitted for Nightshift at Panel D, 14m after that review ended. " +
      "Asha's app last checked in 2m ago; Ben's app last checked in 21m ago.",
  );
  assert.doesNotMatch(items[0]?.statement ?? "", /venue|left|gone/i);
});

test("a scorecard written minutes after the table is not chased", () => {
  const items = scorecardChaseItems({
    now,
    roundId: "round1",
    roundName: "Review 1",
    sessions: [
      {
        reviewSessionId: "rev1",
        teamName: "Nightshift",
        panelName: "Panel D",
        completedAt: now - 3 * minute,
        reviewers: [{ displayName: "Asha", clockInStatus: "present" }],
      },
    ],
  });
  assert.deepEqual(items, []);
});

test("a reviewer with no heartbeat at all is described as exactly that", () => {
  const items = scorecardChaseItems({
    now,
    roundId: "round1",
    roundName: "Review 1",
    sessions: [
      {
        reviewSessionId: "rev1",
        teamName: "Nightshift",
        panelName: "Panel D",
        completedAt: now - 50 * minute,
        reviewers: [{ displayName: "Asha", clockInStatus: "clocked_out" }],
      },
    ],
  });
  assert.equal(items[0]?.severity, "critical");
  assert.match(items[0]?.statement ?? "", /Asha has no reviewer app contact recorded\./);
  assert.match(items[0]?.statement ?? "", /Asha has not submitted/);
});

test("a session where everyone submitted produces nothing", () => {
  assert.deepEqual(
    scorecardChaseItems({
      now,
      roundId: "round1",
      roundName: "Review 1",
      sessions: [
        {
          reviewSessionId: "rev1",
          teamName: "Nightshift",
          panelName: "Panel D",
          completedAt: now - 40 * minute,
          reviewers: [],
        },
      ],
    }),
    [],
  );
});

test("dedupe keys are identity, so a changing reading keeps the same key", () => {
  const at = (queuedAt: number) =>
    reviewFloorItems(floor({ panels: [panel()], teams: [team({ queuedAt })] })).map(
      (item) => item.dedupeKey,
    );
  assert.deepEqual(at(now - 21 * minute), at(now - 45 * minute));
});

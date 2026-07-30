# Panel and queue operations

## 1. Objectives

- Put relevant expertise in front of each team.
- Prevent absent reviewers from silently degrading a panel.
- Keep queue movement predictable under uneven review duration.
- Balance reviewer workload.
- Make every substitution and assignment explainable.

## 2. Panel construction

Review administrators create a staffing plan per round using:

- required panel size (working assumption: three scoring reviewers)
- required criterion coverage
- track/domain demand forecast
- reviewer expertise and verified criterion grants
- availability and training
- conflicts of interest
- organisational diversity
- accessibility constraints
- maximum assignment load

A panel must collectively cover all rubric criteria required for the round. A panel can review any team if it has the required coverage; it is not permanently locked to one track.

The system may recommend panels, but an administrator approves and publishes them. Recommendations include a plain-language rationale and warnings.

## 3. Conflict rules

A reviewer is ineligible for a team if they:

- are a team member or close collaborator;
- mentored or materially contributed to the project;
- have a declared personal conflict;
- have another conflict defined by event policy.

Reviewers must be able to declare a newly discovered conflict immediately. The system removes them from that team assignment and begins substitution without revealing sensitive conflict details to participants.

## 4. Clock-in and readiness

Before a round:

1. Reviewer opens the mobile app and completes device/network checks.
2. Reviewer clocks in for the round.
3. App confirms assigned panel, rendezvous location, and start window.
4. Panel state becomes complete only when all required members are clocked in and available.
5. Operations sees absent, late, device-not-ready, and unacknowledged reviewers.

Clock-in is not proof of presence at a team. Presence for each review is separately confirmed through the team QR.

## 5. Paging and substitution

Triggers include:

- reviewer fails to clock in by threshold;
- reviewer does not acknowledge an assignment/page;
- reviewer declares a conflict;
- reviewer pauses or leaves;
- device becomes unavailable;
- operations marks reviewer missing.

Substitution workflow:

1. Rank eligible substitutes by missing criterion coverage, domain fit, distance/availability, current load, and conflicts.
2. Page the top candidate with panel, location, urgency, and accept/decline actions.
3. If not accepted within the configured window, page the next candidate.
4. On acceptance, update panel membership for the applicable scope.
5. Preserve the original membership and reason in audit.
6. Notify panel and operations.

Board administrators can force-assign a substitute. They cannot bypass an identified conflict without a separate high-severity override.

## 6. Team-to-panel assignment

Assignment considers:

- track
- technologies and project domain
- safety/security/AI/data concerns
- required rubric coverage
- declared conflicts
- panel workload and location
- prior-round panel, to balance continuity and independent review

The recommendation must state why a panel fits and identify missing expertise. Administrators can accept, change, or lock assignments.

Using the same panel in later rounds is not automatic. Continuity helps verify commitments, while rotation reduces repeated bias. The policy remains open and must be configured per round.

## 7. Queue model

Each round can have multiple panel queues. A queue entry contains:

- team, table, and round
- assigned panel
- readiness timestamp
- priority class and reason
- current ordinal
- estimated window
- status and hold reason
- assignment revision

Normal ordering is stable and explainable. Manual reprioritisation requires a reason. Teams on hold do not block all following teams.

### Queue lifecycle

`Draft → Ready → Queued → Called → Accepted by panel → In review → Submitted → Complete`

Alternate transitions:

- `Ready/Queued → Withdrawn`
- `Queued/Called → Hold → Queued`
- `Called → Missed → Hold or Requeued`
- `Any pre-review state → Cancelled`

Only one active queue entry per team per round is allowed.

## 8. Readiness-based operation

Readiness reduces wasted travel and idle panel time, but does not create an unbounded first-come advantage. Each round defines:

- readiness opening time
- scheduled cohort/window, if any
- late policy
- maximum hold time
- priority categories
- whether teams may see exact ordinal or only teams-ahead/window

If a team is not ready when its scheduled cohort activates, the system moves it to a visible hold and continues the queue.

## 9. Starting a review

A standard review starts only if:

- team and panel assignment are current;
- the team table is confirmed;
- all required panel members are clocked in;
- every required reviewer scans the current team QR;
- no reviewer conflict is active;
- the review has not already started elsewhere;
- the server grants a unique review-session lease.

The final item prevents two panels from reviewing the same team concurrently. If connectivity is degraded, the reliability policy defines a controlled provisional lease.

## 10. Timer policy

- Default review budget: 10 minutes (working assumption pending final configuration).
- The app shows elapsed and remaining time to the panel.
- At threshold, a panel member can request **+2 minutes**.
- Extensions are discrete, visible, and audited.
- The allowed number of ordinary extensions is configurable.
- Beyond that, an administrator approves the extension or the review must conclude.
- Overrun never deletes a draft; it blocks completion only if required justification is missing.

Time metrics are used to improve operations, not reward superficial reviews.

## 11. Operational exceptions

| Exception | Default response |
| --- | --- |
| Reviewer absent | Begin substitution paging |
| Team at wrong table | Verify and update table before call |
| Team not present | Put on hold; continue queue |
| QR cannot load | Staff verifies signed fallback identifier |
| Duplicate live review | Keep lease holder; freeze second attempt |
| Conflict discovered mid-review | Pause, preserve draft, substitute, record scope |
| Device dies | Replace device/session; recover server-acknowledged draft |
| Network degraded | Enter safe degraded mode; show unsynced status |
| Unsafe conduct | Pause review and escalate to board/safety lead |
| Round close with incomplete team | Explicit incomplete disposition; never silently drop |

## 12. Acceptance criteria

- An incomplete panel cannot begin without an authorised override.
- Every reviewer presence proof is tied to a specific review session.
- No team has two active review sessions in one round.
- A queue can continue when a team or panel is held.
- Every assignment and reprioritisation has a recorded rationale.
- Substitution preserves criterion coverage or raises a visible critical warning.
- Participants receive a comprehensible status within seconds of an operational change once connected.
- Operations can reconcile all incomplete queue entries before closing a round.


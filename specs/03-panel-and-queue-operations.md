# Panels and queues

## 1. Operating model

A panel is a group of reviewers assigned to one or more venue tables for a round. A queue contains teams that the panel can review.

In the judging documents, “reviewer” normally means a person rostered as External Judge, but authorization comes from the panel/review permission grants. Any event-linked person with the same exact assignment grants can judge regardless of role. Panel coordinator is a per-panel assignment, not another role.

The working panel size is three scoring reviewers. Final panel size and criterion-coverage rules remain event policy.

## 2. Reviewer profile

A caller with `reviewer.profile.manage` prepares each reviewer record before the event:

- approved Google email;
- name and contact number;
- reviewer type for staffing only;
- technical domains;
- product/user domains;
- published core/sponsor track-version keys the reviewer can assess;
- rubric criteria the reviewer can score;
- languages;
- venue availability windows;
- conflicts and restricted teams;
- accessibility or scheduling needs;
- app and training status.

Reviewer type or seniority never changes score weight.

## 3. Panel planning

The planning screen builds panels from the roster and the selected rubric version.

A valid panel must satisfy:

- required number of reviewers;
- minimum scorer count for every active criterion;
- at least one reviewer who can assess the team’s main technical area;
- no known team conflict;
- no overlapping assignment;
- reviewer availability for the round;
- one named panel coordinator.

The planner shows gaps before a panel can be published. It also estimates how many reviews the panel can complete from the configured duration and round window.

Publishing a plan creates a version. Later edits keep the previous version and record who changed which seat.

### Changing a seat after publication

Panels are built when a round is published, and teams are never pre-assigned to them — the desk sends each team to a panel when it is ready. The operations dashboard must state that model where panels are built, because a screen full of forms with no account of how rounds, panels and routing relate cannot be used by someone who has not read this document.

A published panel still has to be changeable. People go home sick, and waiting for a no-show to trigger the substitute chain is not a reasonable answer. An authorized operator can swap one reviewer for another on a live panel under its own exact permission, with the panel's current version, a reason, a fresh Google session, and an audit event.

The command refuses in three cases:

- a review is under way on that panel — presence records and criterion assignments are pinned to the seats that existed when it started, so changing them mid-review would invalidate both;
- the change would leave the panel without a coordinator;
- the joining reviewer already holds a seat on that panel.

The leaving seat is marked replaced rather than deleted, so the round export can still explain who held it and when. The leaving reviewer's panel grants are revoked and the joining reviewer's are materialized in the same transaction; neither is hand-written.

## 4. Routing teams

Panels are not fixed only by track. The router reads the confirmed core-track version, any sponsor eligibility, the team-confirmed brief, and reviewer domain tags. The router never reads an unconfirmed model suggestion. A security project still needs product and communication coverage. A health project still needs technical and responsible-use coverage.

The routing function first removes ineligible panels:

- known reviewer conflict;
- panel unavailable or paused;
- no required criterion coverage;
- team already reviewed by the panel when policy forbids continuity;
- table or venue zone unavailable;
- panel at its capacity limit.

It then ranks eligible panels using:

1. confirmed core-track and team-domain match;
2. rubric coverage;
3. current queue length and observed review pace;
4. continuity or rotation policy for the round;
5. venue distance from the panel's current position to the team's mapped hall spot;
6. number of recent manual exceptions.

The ranker is deterministic code with a recorded rules version. It does not call a language model.

A sponsor-track entry can require an eligible domain reviewer for sponsor-award evidence when that policy is published. It cannot remove ordinary rubric coverage, guarantee a sponsor judge, or route a team into a separate scoring formula by itself.

Operations can auto-accept the top result for ordinary teams during a configured assignment window. A manual choice outside the top result requires a reason. Assignment becomes fixed when the team enters `queued`; later moves use the exception flow.

## 5. Hall mapping

A panel has no table. A panel is a group of reviewers who walk to whichever team they are reviewing, so the only location in a review is the team's own. Two records describe it. A `teamFloorLocation` is where the team is seated in the hall, recorded by roving floor staff and used for routing. `teamRoundStates.tableLabel` is the label of that spot captured for the round, and it is what a called reviewer is told to walk to.

Operations publishes a versioned hall plan from a checked CSV of zones and spots. Each spot has one stable key, human label, zone, percentage coordinates for the simple map, accessibility flag, and open/closed state. The plan remains replaceable only until the first team location is saved.

Roving floor staff record locations roughly 90 minutes before the review window:

1. the mapper selects one zone covered by their exact grant;
2. the team opens the hall-location QR on its own dashboard;
3. the mapper scans it while standing with the team;
4. the app shows the team and any current location;
5. the mapper taps the physical spot and waits for server confirmation.

No QR is attached to a table. The team credential identifies the team. The mapper identifies the spot from the published plan. The scan consumes one short-lived token and creates an operator-owned claim before the spot write. The server serializes replay, two mappers scanning one code, two teams claiming one spot, and two claims for one team. These actions cannot overwrite each other.

Operations freezes the hall map 30–60 minutes before routing. The server rejects the freeze until every currently confirmed/checked-in/active team has one location. A selected or offer-pending team is not yet mapping-eligible. A later physical correction requires the separate override permission for every affected zone and a reason. The correction supersedes history. It does not edit history.

Before freeze, the dashboard lists:

- unassigned teams;
- occupied or closed spots;
- inaccessible placements that need correction;
- zone capacity.

The official hall spot comes from the server. Participants may show a fresh code for correction but cannot silently change the record.

## 6. Reviewer clock-in

A reviewer clocks in from the reviewer app at the venue.

The server checks:

- active roster grant;
- current event and availability window;
- registered, non-revoked device;
- minimum app build;
- notification permission and token;
- camera permission or documented scanner fallback;
- no unresolved conflict/training block.

Clock-in states are:

`expected → present → temporarily_unavailable → clocked_out`

Operations may mark a no-show after the configured grace period. The change records the operator and reason.

The app sends a low-frequency heartbeat while active. A stale heartbeat is an attention signal, not proof that the reviewer left. Operations confirms status before removing a panel seat.

## 7. Missing reviewer and substitute

When a required seat is empty or a reviewer becomes unavailable:

1. the panel changes to `needs_reviewer`;
2. the server ranks eligible substitutes by criterion coverage, domain match, conflict status, active workload, location, and recent pages;
3. the highest eligible reviewer receives a page;
4. the reviewer accepts or declines in the app;
5. an accepted page creates the replacement assignment and cancels later candidates;
6. a declined or expired page advances to the next candidate;
7. operations sees the entire page chain and can select a different eligible reviewer.

The working acknowledgment window is 90 seconds and remains configurable.

A delivered push does not count as acceptance. Only an authenticated in-app action can accept the page. If no candidate responds, operations calls the reviewer or sends a floor runner while the exception stays visible.

## 8. Queue

### States

There is no participant transition into a review round. Before staff placement, no team/round row is required. `queue.manage` for the selected panel creates the row directly as:

`queued → called → at_table → in_review → completed`

`unassigned` is an operations-only state used when a conflict or manual exception requires a new panel choice. Staff can route it back to `queued`; participants cannot cause this transition.

Exceptional states are:

- `held`
- `missed`
- `withdrawn`

A panel move preserves `queued` and records the previous panel, new panel, actor, reason, and version. Every exceptional state stores a reason and the actor.

### Ordering

Within the set of teams an eligible panel can review, the default order is:

1. earliest accepted `queuedAt`;
2. teams returning from an approved hold;
3. tie-break by stable team ID.

Routing and conflict constraints may create different visible queues per panel. Operations can reprioritize a team only with a reason code such as accessibility, hardware incident, venue safety, or correction of an earlier operations error.

### Participant display

Participants see:

- current state;
- assigned table when safe to show;
- their current ordinal and the ordinal now being called;
- number of teams ahead;
- a coarse time window;
- whether staff have paused new review calls and starts;
- a clear action when called or held.

The server derives the ordinal from the current eligible queue. It can change after an approved hold or move. The UI explains the change. The estimate uses the current review's remaining planned time and a bounded panel pace. Pace begins with the configured duration. After three samples, it uses the median of up to nine recent valid completions. The server widens the result and rounds it to five-minute buckets. It updates the estimate when a review starts, completes, extends, changes panel, or changes queue position. The server withholds the estimate during a round pause. The estimate never promises an exact minute.

### Calling a team

The panel or operations user calls the next eligible team. The server records `calledAt` and the expected table.

The live board shows each team's active-member count, currently-inside count, and the round minimum. Before calling, the server reads those current participant venue projections in the same transaction as the queue transition. A team below the published minimum remains queued; the failed call creates no review, assignment, scorecard, or evidence checkpoint. One temporarily out member does not automatically mark the team missed or remove its queue time. Operations can wait or apply the separately authorized hold flow.

An exceptional call requires `review.participant_availability.waive` for that exact team or an explicit event-wide grant. It also requires a reason, the same idempotent call operation, and a Google session created within the last 15 minutes. Before the transaction creates the called review, it records an immutable waiver. The waiver contains the observed and required counts, authorizing grant IDs, actor, and time. If availability drops after the call, the same permission can cover that exact review or team. The system records the waiver against the current pending-review version. A waiver never changes attendance and cannot be copied to another review. The team portal only asks members to regroup. It does not show the exception reason or identify the person who is away.

The final missed-call grace period, number of calls, and re-entry position are open decisions. The dashboard must not implement a hidden default.

### Round-wide incident pause

An authorized operator can pause new calls and starts for one open round only after choosing an active review-backend incident that they may read. The pause is a separate versioned record, not another round lifecycle state. Teams already in a panel queue keep their position, and a review already active or overdue can keep saving and finish normally.

`review.round.pause` and `review.round.resume` are independent exact-round permissions. Both commands require a Google session created within the last 15 minutes, the current round and pause versions, a reason, and a stable operation ID. The pause mutation increments the round version, so a concurrent call, start, or close either commits first or retries against the pause and fails. An incident cannot resolve while one of its round pauses remains active.

## 9. Reviewer presence

Each assigned reviewer scans the review-presence team QR from their signed-in device.

The server checks:

- token signature, event, round, team, and expiry;
- reviewer is an active member of the assigned panel;
- team is called or at the expected table;
- no conflict appeared after assignment;
- reviewer has not already scanned for that session.

The presence record stores reviewer, device, scan time, token version, and result. A reviewer cannot scan for another reviewer.

If the camera fails, the judge types the fallback code. If both methods fail, `review.presence.waive` for that review may waive one or more presence requirements. The override names each missing judge, grant, actor, and reason.

## 10. Starting the review

The server starts a review only when:

- round is open;
- no active round-wide incident pause exists;
- team, panel, assignment, and table are current;
- no other active review exists for the team or panel;
- required reviewer presence is complete or a valid scoped presence waiver exists;
- the current configured minimum participant availability is met in the transactionally maintained team projection, or an immutable `review.participant_availability.waive` record exists for this review;
- the rubric and criterion assignments are fixed;
- required project and integration snapshots exist.

One accepted start creates:

- review session ID;
- server `startedAt`;
- planned end time;
- project and snapshot references;
- panel-plan version;
- rubric version;
- criterion assignments.

All clients calculate elapsed time from `startedAt`. They do not send one write per second.

The start response also includes `serverNow`. Each client calculates remaining time from the observed server offset and advances it with a monotonic device clock. A live update resynchronizes the offset after foregrounding or reconnect.

## 11. Timer and extension

The working duration is 10 minutes. The working ordinary extension is one two-minute block.

- The app warns reviewers at configured remaining times.
- The panel coordinator requests an extension.
- The server checks the remaining allowance and updates `extensionSeconds`.
- Operations sees the new end time immediately.
- Expiry marks the review overdue; it does not auto-submit unfinished scorecards.
- A further extension or forced close requires `review.timer.extend_exception` or `review.timer.force_close` for that review, as defined by event policy.

Timer settings are frozen with the round configuration.

## 12. Completing the review

A review can complete when:

- every required reviewer has submitted a valid scorecard;
- every active rubric criterion has the required independent coverage;
- panel commitments and the next-checkpoint note are present when the round requires them;
- no scorecard correction is pending;
- the team and panel are still assigned to this session.

The completion mutation closes the session, moves the team to `completed` for the round, frees the panel, and advances the queue.

The panel coordinator may confirm completion. The coordinator cannot edit another judge’s score.

## 13. Failure handling

| Failure | Response |
| --- | --- |
| Reviewer does not arrive | Page substitutes; keep panel visibly blocked until accepted |
| Reviewer phone dies | Move the reviewer to a spare registered device or replace the reviewer |
| Push is late | In-app assignment and dashboard stay current; call or runner is the fallback |
| The team is not where the map says | Hold, correct the team's hall location, then resume |
| QR expired | Refresh the participant QR; do not reuse an old token |
| Duplicate review start | Return the existing active session |
| Two operators move the same team | Accept one current-version command; reject the stale command with the new state |
| Review runs over | Mark overdue and require an explicit extension or close decision |
| Required scorecard missing | Keep the review and round incomplete; page the reviewer or start the approved missing-reviewer process |
| Review incident pauses the round | Keep queue positions and active scorecards; reject new calls, starts, and round close until authorized resume |

## 14. Acceptance checks

- A panel cannot publish with missing criterion coverage.
- A reviewer with a known team conflict is never an eligible route or substitute.
- One accepted substitute page fills one seat and cancels competing pages.
- A push receipt alone never changes the assignment.
- A team cannot have two active review sessions in one round.
- A panel cannot run two active sessions at once.
- A review cannot start without required presence or a recorded waiver created through `review.presence.waive` for that review.
- A team below the published participant minimum cannot be called or started unless a freshly authenticated holder of `review.participant_availability.waive` records one immutable exception for that exact team/review; the exception changes no attendance state.
- A temporarily out participant produces the configured regroup/hold flow rather than silently marking the team missed.
- Participant attendance and reviewer QR presence cannot satisfy one another.
- The participant and operations queue change after the same accepted server write.
- Timer reloads calculate the same end time on every client.
- Queue moves, holds, overrides, extensions, and forced closes retain actor and reason.
- A round pause racing a call, start, incident resolution, or round close has one transactionally consistent winner.
- Participant and reviewer clients show the generic pause state without receiving the internal incident summary unless they independently hold incident read access.

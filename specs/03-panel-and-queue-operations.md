# Panels and queues

## 1. Operating model

A panel is a group of reviewers assigned to one or more venue tables for a round. A queue contains teams that the panel can review.

The working panel size is three scoring reviewers. Final panel size and criterion-coverage rules remain event policy.

## 2. Reviewer profile

Review operations prepares each reviewer record before the event:

- approved Google email;
- name and contact number;
- reviewer type for staffing only;
- technical domains;
- product/user domains;
- tracks the reviewer can assess;
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
- one named panel lead.

The planner shows gaps before a panel can be published. It also estimates how many reviews the panel can complete from the configured duration and round window.

Publishing a plan creates a version. Later edits keep the previous version and record who changed which seat.

## 4. Routing teams

Panels are not fixed only by track. A cybersecurity project still needs product and communication coverage; a health project still needs technical and responsible-use coverage.

The routing function first removes ineligible panels:

- known reviewer conflict;
- panel unavailable or paused;
- no required criterion coverage;
- team already reviewed by the panel when policy forbids continuity;
- table or venue zone unavailable;
- panel at its capacity limit.

It then ranks eligible panels using:

1. team-domain match;
2. rubric coverage;
3. current queue length and observed review pace;
4. continuity or rotation policy for the round;
5. venue distance when the floor map contains zones;
6. number of recent manual exceptions.

The ranker is deterministic code with a recorded rules version. It does not call a language model.

Operations can auto-accept the top result for ordinary teams during a configured assignment window. A manual choice outside the top result requires a reason. Assignment becomes fixed when the team enters `queued`; later moves use the exception flow.

## 5. Table preparation

Operations records team-to-table assignments roughly 90 minutes before the review window and freezes them 30–60 minutes before routing.

Before freeze, the dashboard lists:

- unassigned teams;
- duplicate table claims;
- inaccessible or closed tables;
- teams whose reported table differs from the operations table;
- panels without a table;
- zone capacity.

The official table comes from the server. Participant confirmation reports a mismatch but does not silently change it.

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

The working acknowledgement window is 90 seconds and remains configurable.

A delivered push does not count as acceptance. Only an authenticated in-app action can accept the page. If no candidate responds, operations calls the reviewer or sends a floor runner while the exception stays visible.

## 8. Queue

### States

`not_ready → ready → queued → called → at_table → in_review → completed`

Exceptional states are:

- `held`
- `missed`
- `withdrawn`
- `moved`

Every exceptional state stores a reason and the actor.

### Ordering

Within the set of teams an eligible panel can review, the default order is:

1. earliest accepted `readyAt`;
2. teams returning from an approved hold;
3. tie-break by stable team ID.

Routing and conflict constraints may create different visible queues per panel. Operations can reprioritise a team only with a reason code such as accessibility, hardware incident, venue safety, or correction of an earlier operations error.

### Participant display

Participants see:

- current state;
- assigned table when safe to show;
- their current ordinal and the ordinal now being called;
- number of teams ahead;
- a coarse time window;
- a clear action when called or held.

The ordinal is derived from the current eligible queue and may change after an approved hold or move; the UI explains the change. The estimate uses active review start times and recent panel duration. It updates when a review starts, completes, extends, or changes panel. It never promises an exact minute.

### Calling a team

The panel or operations user calls the next eligible team. The server records `calledAt` and the expected table.

The final missed-call grace period, number of calls, and re-entry position are open decisions. The dashboard must not implement a hidden default.

## 9. Reviewer presence

Each assigned reviewer scans the team QR from their signed-in device.

The server checks:

- token signature, event, round, team, and expiry;
- reviewer is an active member of the assigned panel;
- team is called or at the expected table;
- no conflict appeared after assignment;
- reviewer has not already scanned for that session.

The presence record stores reviewer, device, scan time, token version, and result. A reviewer cannot scan for another reviewer.

If the camera fails, the reviewer types the fallback code. If both methods fail, a board member may waive one or more presence requirements. The override names each missing reviewer and records a reason.

## 10. Starting the review

The server starts a review only when:

- round is open;
- team, panel, assignment, and table are current;
- no other active review exists for the team or panel;
- required presence is complete or a valid board override exists;
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

The start response also includes `serverNow`. Each client calculates remaining time from the observed server offset and advances it with a monotonic device clock. A live update resynchronises the offset after foregrounding or reconnect.

## 11. Timer and extension

The working duration is 10 minutes. The working ordinary extension is one two-minute block.

- The app warns reviewers at configured remaining times.
- A panel lead requests an extension.
- The server checks the remaining allowance and updates `extensionSeconds`.
- Operations sees the new end time immediately.
- Expiry marks the review overdue; it does not auto-submit unfinished scorecards.
- A further extension or forced close requires a review-operations or board action under event policy.

Timer settings are frozen with the round configuration.

## 12. Completing the review

A review can complete when:

- every required reviewer has submitted a valid scorecard;
- every active rubric criterion has the required independent coverage;
- panel commitments and the next-checkpoint note are present when the round requires them;
- no scorecard correction is pending;
- the team and panel are still assigned to this session.

The completion mutation closes the session, moves the team to `completed` for the round, frees the panel, and advances the queue.

The panel lead may confirm completion. The lead cannot edit another reviewer’s score.

## 13. Failure handling

| Failure | Response |
| --- | --- |
| Reviewer does not arrive | Page substitutes; keep panel visibly blocked until accepted |
| Reviewer phone dies | Move the reviewer to a spare registered device or replace the reviewer |
| Push is late | In-app assignment and dashboard stay current; call or runner is the fallback |
| Team is at the wrong table | Hold, correct the official table, then reroute or resume |
| QR expired | Refresh the participant QR; do not reuse an old token |
| Duplicate review start | Return the existing active session |
| Two operators move the same team | Accept one current-version command; reject the stale command with the new state |
| Review runs over | Mark overdue and require an explicit extension or close decision |
| Required scorecard missing | Keep the review and round incomplete; page the reviewer or start the approved missing-reviewer process |

## 14. Acceptance checks

- A panel cannot publish with missing criterion coverage.
- A reviewer with a known team conflict is never an eligible route or substitute.
- One accepted substitute page fills one seat and cancels competing pages.
- A push receipt alone never changes the assignment.
- A team cannot have two active review sessions in one round.
- A panel cannot run two active sessions at once.
- A review cannot start without required presence or a recorded board override.
- The participant and operations queue change after the same accepted server write.
- Timer reloads calculate the same end time on every client.
- Queue moves, holds, overrides, extensions, and forced closes retain actor and reason.

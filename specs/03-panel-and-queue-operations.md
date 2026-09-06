# Panels and queues

## 1. Operating model

A panel is a stable review station with a queue. Teams report to the review desk and staff place them into a suitable panel's queue.

In the judging documents, “reviewer” means a person assigned to judge, including Board, SC, JC or External Judge; authorization comes from the panel/review permission grants. Any event-linked person with the same exact assignment grants can judge regardless of role. Panel coordinator is a per-panel assignment, not another role.

The event defaults to six or seven panels, each with five reviewers: one Board lead, two SC, and two JC. If a Board member is unavailable, the strongest eligible available SC fills the lead seat in addition to the two SC seats. JC seats rotate. Every seat, including the lead, must be replaceable while preserving the configured composition and criterion coverage.

All operational settings belong in the ops dashboard. Panel count, seat count and composition, fallback rules, rotation, confirmation time, duration, call and reminder timing, and replacement deadlines are editable event policy. The values in this document are defaults. Published changes are versioned and cannot silently alter a review already underway.

These are the agreed event requirements. See [Event review readiness](15-event-review-readiness.md) for implementation status; a requirement in this handbook does not mean the corresponding automation is complete.

## 2. Reviewer profile

A caller with `reviewer.profile.manage` prepares each reviewer record before the event:

- approved Google email;
- name and contact number;
- reviewer type for staffing only;
- technical domains;
- product/user domains;
- rubric criteria the reviewer can score;
- languages;
- current round availability confirmations;
- conflicts and restricted teams;
- accessibility or scheduling needs;
- app readiness and active profile status.

Reviewer type or seniority never changes score weight.

The reviewer form's hour selections are discarded because the form mistakenly capped answers at three. Its respondents constitute the whole reviewer pool. The import keeps the latest response per email, seniority, domain, declared skills, resume link, and GitHub reference. These declarations help staff prepare profiles; they do not certify training or grant criterion qualifications.

Reviewer assessment is a one-time preparation task performed with the event owner in the planning conversation. The owner supplies resumes and metadata matched by email. The prepared output records evidence-backed domain and criterion qualifications, lead suitability, uncertainty, provisional panels, and replacement candidates. The existing roster importer admits the people and their source references; existing reviewer-profile and panel-publication commands apply the assessment and plan. There is no new resume crawler, recurring reviewer-assessment agent, or separate profile-import product. Actual training completion remains separately recorded.

Prepared panels are provisional. App confirmations, current availability, conflicts, clock-in, and qualified replacements continue to govern live staffing and fair JC rotation. See [Event follow-up plan](16-event-follow-up-plan.md) for the preparation handoff and remaining implementation work.

Availability belongs to each round. Around 23:00 IST, the app asks each rostered person to confirm every time window they can cover or explicitly decline. Reviewers can revise their response. The server merges touching or overlapping windows, checks round boundaries, and requires enough time for a complete review. A pending response is not availability, and confirmation is not arrival.

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

Round publication schedules the app confirmation request and includes the complete selected pool as seats or reserves. Initial seats are provisional until people confirm. Reserves can confirm while profile assessment is still in progress; actual clock-in and substitution still require completed qualifications and a registered device. Clock-in, joining a panel, paging a substitute, calling a team, and starting a review recheck the person's confirmed coverage for the next complete review. No profile must promise availability for the whole round.

Round configuration records clock-in opening, initial report time, and no-show grace. Shift rotation must use each person's confirmed hours, page them five minutes before their assignment, and replace departing or nonresponding people promptly. A later confirmed shift must not be treated as a round-start no-show. The staffing scheduler rechecks confirmed shifts and starts replacement pages when needed; a native reminder precedes a confirmed shift.

### Changing a seat after publication

Operations builds panels when it publishes a round. It does not pre-assign teams. The review desk sends each ready team to a panel. The operations dashboard must show this relationship.

A published panel still has to be changeable. People go home sick, and waiting for a no-show to trigger the substitute chain is not a reasonable answer. An authorized operator can swap one reviewer for another on a live panel under its own exact permission, with the panel's current version, a reason, a current scoped authorization, and an audit event.

The command refuses in three cases:

- a review is active on that panel because its presence records and criterion assignments are pinned to the starting seats;
- the change would leave the panel without a coordinator;
- the joining reviewer already holds a seat on that panel.

The leaving seat is marked replaced rather than deleted, so the round export can still explain who held it and when. The leaving reviewer's panel grants are revoked and the joining reviewer's are materialized in the same transaction; neither is hand-written.

## 4. Routing teams

The review desk can choose automatic panel selection or explicitly select a panel. Automatic selection reads the submitted project/answers and connected repository languages alongside the assessed reviewer domain tags. It uses no novelty-preview number or admission-model output.

A candidate must be ready, fully staffed, authorized for the operator, conflict-free, qualified for the published criterion coverage, on duty and confirmed for another complete review. The configured preference is either domain matches followed by shortest estimated wait, or shortest wait alone. Estimates use observed completed reviews plus the configured score-entry allowance. Matching is deterministic text/tag matching, not a model judgment. The accepted panel, matched domains, estimate and rules version are audited.

Placement and its eligibility checks happen in one transaction, and an uncertain retry cannot place the team twice. The selected panel is fixed when the team enters `queued`; a later change uses the reasoned move workflow. Staff still decide when a walk-up team enters the review queue.

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

The server uses its own time. Clock-in is accepted at the exact published opening and remains open until, but not including, round end. It rechecks the reviewer's round confirmation before any clock-in, device, operation, or audit write. Returning from a break rechecks that confirmation too.

Clock-in states are:

`expected → present → temporarily_unavailable → clocked_out`

Operations may mark a no-show at or after `reviewerReportAt + noShowGraceSeconds`. For a reviewer who explicitly stepped away, the same published grace starts at their expected return time. A present reviewer cannot be marked no-show. The no-show command reads the current clock-in and panel versions in the same transaction as removing the seat, so a clock-in racing a no-show cannot leave both states accepted. A rejected command writes nothing. The accepted change records the operator and reason.

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

The setup defaults to a 30-second acknowledgment window. A page timeout must advance to another eligible candidate promptly. Acceptance and physical arrival remain distinct; an accepted replacement who does not arrive also needs replacement. Paging cadence and any phone escalation must fit within the acknowledgment window rather than waiting until the page has already expired.

A delivered push does not count as acceptance. The system sends push first. If the reviewer gave current call consent and does not acknowledge by the first reminder, the reusable outbound-calling service can place a synthesized call under the page chain's still-current `review.substitute.page` authority. That reminder occurs at half the response window, capped at 30 seconds, so the default 30-second page can escalate at 15 seconds before it expires. If push is unavailable, the call can start at once. Only an authenticated in-app action accepts or declines the page. If no candidate responds, the server advances to the next candidate and operations sends a floor runner. The exception stays visible.

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
- their current ordinal and the ordinal now being called;
- number of teams ahead;
- a coarse time window;
- whether staff have paused new review calls and starts;
- a clear action when called or held.

The server derives the ordinal from the current eligible queue. It can change after an approved hold or move. The UI explains the change. The estimate uses the current review's remaining planned time and a bounded panel pace. Pace begins with the configured duration. After three samples, it uses the median of up to nine recent valid completions. The server widens the result and rounds it to five-minute buckets. It updates the estimate when a review starts, completes, extends, changes panel, or changes queue position. The server withholds the estimate during a round pause. The estimate never promises an exact minute.

### Calling a team

The panel or operations user calls the next eligible team. The server records `calledAt`.

The live board shows each team's active-member count, currently-inside count, and the round minimum. Before calling, the server reads those current participant venue projections in the same transaction as the queue transition. A team below the published minimum remains queued; the failed call creates no review, assignment, scorecard, or evidence checkpoint. One temporarily out member does not automatically mark the team missed or remove its queue time. Operations can wait or apply the separately authorized hold flow.

An exceptional call requires `review.participant_availability.waive` for that exact team or an explicit event-wide grant. It also requires a reason, the same idempotent call operation, and a current scoped authorization. Before the transaction creates the called review, it records an immutable waiver. The waiver contains the observed and required counts, authorizing grant IDs, actor, and time. If availability drops after the call, the same permission can cover that exact review or team. The system records the waiver against the current pending-review version. A waiver never changes attendance and cannot be copied to another review. The team portal only asks members to regroup. It does not show the exception reason or identify the person who is away.

Operations explicitly publishes the missed-call grace period, required call attempts, and re-entry policy with the round. Setup currently proposes 180 seconds, two attempts, and preservation of the original queue time; the operator can change those values before publication.

### Round-wide incident pause

An authorized operator can pause new calls and starts for one open round only after choosing an active review-backend incident that they may read. The pause is a separate versioned record, not another round lifecycle state. Teams already in a panel queue keep their position, and a review already active or scoring can keep saving and finish normally.

`review.round.pause` and `review.round.resume` are independent exact-round permissions. Both commands require a current scoped authorization, the current round and pause versions, a reason, and a stable operation ID. The pause mutation increments the round version, so a concurrent call, start, or close either commits first or retries against the pause and fails. An incident cannot resolve while one of its round pauses remains active.

## 9. Reviewer presence

Each assigned reviewer scans the review-presence team QR from their signed-in device.

The server checks:

- token signature, event, round, team, and expiry;
- reviewer is an active member of the assigned panel;
- team is called or has met the panel;
- no conflict appeared after assignment;
- reviewer has not already scanned for that session.

The presence record stores reviewer, device, scan time, token version, and result. A reviewer cannot scan for another reviewer.

The phone saves one stable operation ID before it sends the confirmation. The operation identifies the review, reviewer, and registered phone. It does not identify one short-lived QR value. If the response is uncertain, the reviewer scans the current code and the phone retries the same operation. A committed retry returns the first confirmation receipt and does not use later presence totals. The phone clears its saved retry only after the response succeeds or subscribed review state proves that the confirmation committed or is no longer actionable.

If the camera fails, the judge types the fallback code. If both methods fail, `review.presence.waive` for that review may waive one or more presence requirements. The override names each missing judge, grant, actor, and reason.

## 10. Starting the review

The server starts a review only when:

- round is open;
- no active round-wide incident pause exists;
- team, panel, and assignment are current;
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

## 11. Review timer and score entry

The discussion limit defaults to seven minutes and is configurable in ops. The app shows the server-based countdown and tells the panel to finish the discussion at expiry. Score entry and required final comments remain available afterwards. Finishing that paperwork must not extend the team's discussion or silently submit unfinished work.

Operations and participant estimates need to distinguish discussion time from score-entry delay. The next team receives a call-up and sees its queue position, estimated review time, and current pace. Late scorecards remain visible until every required reviewer finishes; they must not be silently dropped to make a panel look complete.

The setup defaults to seven minutes and zero ordinary extensions. The deadline transition ends discussion, keeps score entry open and prevents rotation until review completion.

## 12. Completing the review

A review can complete when:

- every required reviewer has submitted a valid scorecard;
- every reviewer has left a final comment at the end of the review;
- every active rubric criterion has the required independent coverage;
- panel commitments and the next-checkpoint note are present when the round requires them;
- no scorecard correction is pending;
- the team and panel are still assigned to this session.

The completion mutation closes the session, moves the team to `completed` for the round, frees the panel, and advances the queue.

Any assigned reviewer may confirm completion after every active reviewer has submitted their scorecard and final comment and any required shared notes are complete. Removed assignments and their historical scorecards do not block completion. Reviewers cannot edit another judge’s score.

## 13. Failure handling

| Failure                          | Response                                                                                                      |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Reviewer does not arrive         | Page substitutes; keep panel visibly blocked until accepted                                                   |
| Reviewer phone dies              | Move the reviewer to a spare registered device or replace the reviewer                                        |
| Push is late                     | In-app assignment and dashboard stay current; call or runner is the fallback                                  |
| QR expired                       | Refresh the participant QR; do not reuse an old token                                                         |
| Duplicate review start           | Return the existing active session                                                                            |
| Discussion reaches seven minutes | End discussion; keep score entry and final comments available                                                 |
| Required scorecard missing       | Keep the review and round incomplete; page the reviewer or start the approved missing-reviewer process        |
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


## Venue confirmation and simpler reviewer actions

GPS is advisory. Sustained outside readings prompt an app reminder and, when configured and consented, a conversational check-in call. Ops selects the published voice agent/version and timing; the response and transcript are recorded separately from GPS and call delivery status. A current explicit unavailable answer can end duty and request a substitute between reviews. Active discussion and unfinished scorecards remain locked; unclear answers or requests for help need ops follow-up. No answer never becomes confirmation. Normal clock-in is the return-to-duty action and cancels an older unresolved check.

The review brief is optional: complete eligible repository text and stored Figma structure are analysed in resumable batches before synthesis. The default is up to three grounded follow-ups, including none when the fixed rubric is enough. The reviewer sees a concise brief in the existing app style. Ops can also enable inspection of captured Figma renders with exact frame/checksum references. Binary repository assets, inaccessible resources, preview capture limits and runtime verification remain explicit limitations. See [current implementation and rehearsal](15-event-review-readiness.md).

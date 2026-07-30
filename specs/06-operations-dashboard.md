# Operations dashboard

## 1. Purpose

The dashboard is the floor-control application for staff. It answers:

- Which rounds are open?
- Which teams are ready, waiting, called, held, or overdue?
- Which panels are complete and which seats are empty?
- Where is every active review?
- Which scorecards or criteria are missing?
- Which exception needs a human decision now?

Charts are secondary. The first screen is an ordered exception list and the live floor state.

## 2. Access

Staff authenticate with Google and claim a preloaded roster entry. Each route and command checks event capabilities in Convex.

Common scopes:

- application reviewers can read assigned applications and submit their own recommendations;
- admissions administrators can manage pre-event application assignment, decisions, offers, and capacity;
- venue operations can manage tables and check-in;
- review operations can manage panels, pages, queues, and active reviews;
- review administrators can manage rubrics, corrections, score reveal, and round close;
- event administrators can manage configuration, rosters, grants, and exports;
- board users can perform named emergency overrides;
- auditors can read history but cannot mutate event state.

The dashboard does not contain one unrestricted “admin mode.”

## 3. Admissions

Before the event, the admissions workspace shows:

- submitted/unassigned/in-review applications;
- missing application-review coverage;
- reviewer workload;
- eligibility blockers;
- independent recommendations after each reviewer submits;
- selected, waitlisted, rejected, and information-requested counts;
- offered and confirmed participant counts against venue capacity;
- expiring offers and waitlist promotions.

Admissions can assign applications, request named information, publish decisions, send/expire offers, and promote the waitlist. Every published decision keeps the application version, admission-policy version, reviewer recommendations, actor, and time.

The venue judging rubric and score views do not appear in this workspace.

## 4. Header

Every screen shows:

- event and active round;
- server time;
- dashboard connection state;
- production release ID;
- number of unresolved critical exceptions;
- active incident banner;
- signed-in role and scope.

If the live subscription is stale, command controls disable and the page shows the last server update time.

## 5. Round control

Round states are:

`draft → check_in → open → paused → closing → closed`

The control page shows:

- configured start/end;
- table freeze;
- panel-plan version;
- rubric version;
- timer policy;
- expected and completed teams;
- unresolved readiness, review, score, and correction blockers.

Commands:

- open check-in;
- freeze tables;
- publish panel plan;
- open routing and queues;
- pause or resume new review starts;
- begin closing;
- close the round;
- reopen under board authority.

Opening a round validates all required configuration. Closing validates review and score completeness. A generic confirmation dialog is not enough; the page lists the exact blockers or consequences.

`closing` freezes judging writes and generates the round export. The round reaches `closed` only after the manifest is uploaded and verified. A failed export leaves a visible blocker and retry action.

## 6. Floor and tables

The floor view groups tables by venue zone.

Each table shows:

- official team;
- assigned panel;
- current queue/review state;
- elapsed review time;
- last confirmed activity;
- open support issue.

Staff can:

- assign or correct a team table before freeze;
- report a closed or inaccessible table;
- move a team and panel together;
- place a team on hold;
- resolve a participant-reported mismatch.

After table freeze, every change requires a reason and updates participant, reviewer, and operations views from the same server write.

## 7. Reviewer and panel board

The panel board shows one row per panel:

- table/zone;
- lead;
- planned and current reviewers;
- criterion coverage;
- clock-in and last-seen state;
- current page;
- active team and timer;
- queue length;
- next available estimate;
- conflict or device warning.

Empty seats and coverage gaps appear first.

Available actions:

- inspect eligible substitutes and ranking factors;
- page the next candidate;
- cancel a page;
- mark temporary unavailability or confirmed no-show;
- accept an operator-confirmed phone/runner response only under the approved fallback policy;
- move a reviewer between panels;
- pause or retire a panel.

The UI never claims a substitute is assigned because a push was delivered.

## 8. Queue board

The queue board has columns for:

- ready/unassigned;
- queued by panel;
- called;
- at table;
- in review;
- held;
- missed;
- completed.

Each team card shows readiness time, table, project domain, assigned panel, teams ahead, wait age, and blocker.

Staff can:

- run routing for eligible ready teams;
- accept or change a proposed panel;
- call the next team;
- hold, resume, or move a team;
- mark missed under policy;
- correct an operations error.

Dragging a card is a request to the server, not a local reorder. The server rechecks current queue and returns the accepted position or a conflict.

Manual priority requires a reason code and remains visible on the card until the team completes the review.

## 9. Active reviews

The active-review view sorts by:

1. overdue;
2. missing reviewer presence;
3. disconnected reviewer with unsaved draft;
4. near end;
5. normal.

Each session shows:

- team, panel, table, and round;
- start, planned end, extension, and elapsed time;
- reviewer presence;
- project and checkpoint versions;
- scorecard draft/submitted state;
- criterion coverage;
- conflict/correction state;
- operations actions already taken.

Protected actions:

- issue an allowed extension;
- correct table or panel metadata;
- add a missing-presence board override;
- pause the panel after the current review;
- force-close only under the approved policy;
- open a replacement-review case.

The dashboard does not expose live peer score values to floor operations.

## 10. Scoring completeness

Review administrators receive a separate view containing:

- expected scorecards by team and reviewer;
- criteria covered and missing;
- submitted time;
- score-spread flags;
- conflicts;
- correction requests;
- invalidated or replacement reviews;
- round total only when complete.

The default view shows completeness, not a winner leaderboard during active reviews.

An administrator can open a correction, void an invalid scorecard, or release scores under policy. They cannot type over a submitted score.

## 11. Support desk

Support cases can come from participant, reviewer, or staff screens.

A case contains:

- support code;
- reporter and contact route;
- event/round/team/reviewer references;
- category;
- plain description;
- current owner;
- state and timestamps;
- actions taken.

Categories include identity, team, table, integration, queue, reviewer device, scorecard, accessibility, and safety.

A support case links to the relevant server records but grants no extra permissions.

## 12. Protected command rules

| Command | Minimum capability | Extra check |
| --- | --- | --- |
| Publish application decision | Admissions administrator | admission policy, review coverage, and capacity |
| Promote waitlisted team | Admissions administrator | available confirmed-participant capacity |
| Change table after freeze | Venue operations | reason |
| Move queued team | Review operations | reason and current queue version |
| Assign substitute manually | Review operations | eligibility and conflict check |
| Waive reviewer presence | Board | fresh sign-in and reason |
| Extend beyond ordinary allowance | Board or named review authority | fresh sign-in and reason |
| Open score correction | Review administrator | correction window and reason |
| Void scorecard | Review administrator | evidence and replacement decision |
| Close round | Review administrator | no unresolved blockers |
| Reopen closed round | Board | fresh sign-in and reason |
| Export identifiable records | Event administrator/auditor scope | fresh sign-in and export purpose |

High-impact commands show the current value, proposed value, affected records, and reason before submission.

## 13. Live updates and conflicts

Dashboard panels subscribe to small, indexed Convex queries. A panel row updates when its reviewer, queue, page, review, or exception records change.

The client may show an action as pending. It shows accepted only after the mutation returns.

Commands that can collide include a current record version. If another operator changed the target first, the server rejects the stale command and returns the new state. The UI asks the operator to review it rather than replaying the old action.

High-impact commands also carry a client operation ID. Repeating the same request after a timeout returns the first accepted result.

## 14. Incident mode

An incident commander can post a banner with:

- affected service or venue zone;
- severity;
- instruction to participants/reviewers/staff;
- time opened and last updated;
- owner.

Round pause blocks new review starts but keeps active drafts available. The dashboard has a printable emergency pack containing the current roster, panel/table plan, active sessions, and serialised manual-review sheets. Printing the pack is restricted and audited.

Manual incident records are reconciled after recovery under the reliability procedure.

## 15. Privacy

- Floor views use preferred names and event identifiers, not eligibility documents.
- Phone numbers appear only to support/operations users who need to contact the person.
- Participant registration numbers do not appear on panel boards.
- Score values remain behind review-administrator or board capability.
- Raw provider tokens and session details never appear in the dashboard.
- Exports are purpose-labelled, time-limited, and logged.

## 16. Acceptance checks

- Two dashboards receive the same panel/queue change without refresh.
- An application reviewer cannot read an unassigned application or a peer recommendation before submission.
- A published admission decision points to the reviewed project and admission-policy versions.
- A stale dashboard cannot overwrite a newer table or queue update.
- Floor operations can see missing scorecards without seeing score values.
- A delivered push never appears as substitute acceptance.
- Round close lists exact blocking sessions, criteria, and corrections.
- A board override fails without a fresh session and reason.
- Every after-freeze table move, manual queue priority, presence waiver, correction, and reopen appears in audit history.
- A disconnected or stale dashboard cannot submit commands.

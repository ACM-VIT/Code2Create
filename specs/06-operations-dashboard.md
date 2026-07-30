# Operations dashboard

## 1. Purpose

The dashboard is the floor-control application for staff. It answers:

- Which rounds are open?
- Which attendance session is active, and who is present, temporarily out, late, excused, or unresolved?
- Which entry/exit station is offline, overloaded, or replaying pending scans?
- Which teams are ready, waiting, called, held, or overdue?
- Which panels are complete and which seats are empty?
- Where is every active review?
- Which scorecards or criteria are missing?
- Which exception needs a human decision now?
- Which participant-intake, phase, and track configuration is currently published?

Charts are secondary. The first screen is an ordered exception list and the live floor state.

## 2. Access

Staff authenticate with Google and claim a preloaded roster entry. Each route and command checks event capabilities in Convex.

Common scopes:

- application reviewers can read assigned applications and submit their own recommendations;
- admissions administrators can manage pre-event application assignment, decisions, offers, and capacity;
- attendance operators can use an assigned scan station and resolve a current mismatch;
- attendance leads can manage attendance plans, sessions, credentials, presence corrections, roll call, and restricted exports;
- venue operations can manage tables and one-time venue check-in;
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
- application and reserved-capacity counts by confirmed core-track version when track quotas are enabled;
- offered and confirmed participant counts against venue capacity;
- expiring offers and waitlist promotions.

Admissions can assign applications, request named information, publish decisions, send/expire offers, and promote the waitlist. Every published decision keeps the application version, admission-policy version, reviewer recommendations, actor, and time.

A submitted core-track change creates a new project version. If it affects reviewer assignment, a track quota, or an active offer, admissions receives a re-review/capacity blocker; the dashboard never moves the reservation silently.

The venue judging rubric and score views do not appear in this workspace.

## 4. Intake and track configuration

Event administrators receive a configuration studio. It is not mixed into live floor controls.

The studio has six related editors:

1. **Track catalog:** exactly five core tracks in the working event policy, plus optional sponsor tracks, eligibility, disclosures, examples, domain tags, display order, and status.
2. **Event phases:** schedule-assigned `introduction`, `ideation`, `build`, `intermediate_update`, `review_ready`, and `final_update` definitions and checkpoint mappings.
3. **Intake shell:** the opening, first prompt, required confirmations, brief fields, answer limits, and deterministic fallback prompts.
4. **Question policy:** minimum three and maximum five generated introduction follow-ups, smaller bounds for later phases, allowed purpose keys, 140-character limit, easy-answer rules, skip behaviour, and prohibited topics.
5. **Track/phase guidance:** small guidance overlays and fallback-prompt bindings for a core/sponsor track at an event phase or checkpoint.
6. **Model contract:** approved model ID/snapshot, instruction/schema/evaluation versions, input/output limits, deadlines, retries, and no-tools/`store: false` requirements.

The opening preview must show only **Hello.**, followed by **What is your project about?** and one text box. A preview that renders a long form, chat transcript, assistant persona, or PPT upload cannot publish.

### Draft and publication

- Published versions are immutable. An administrator clones one to make a draft.
- The validator checks stable keys, track count/types, every reference, the introduction's three-to-five question bound, later-phase bounds, generated-question policy, required-confirmation reachability, sponsor eligibility, and deterministic fallback coverage.
- The simulator runs representative project descriptions across every phase/core-track combination and sponsor overlay under model success, rejected-question, timeout, refusal, invalid-output, and disabled-model conditions.
- Publication samples generated paths for human review and requires the evaluation suite to meet thresholds for relevance, easy-answer rate, duplicate/compound-question rate, prohibited-topic/PII rate, average question length, and fallback rate.
- The diff lists participant-visible wording, routing, eligibility, submission requirements, retention/model settings, and the number of active sessions pinned to the previous version.
- Publication uses a fresh session, named capability, summary, and reason. It updates defaults for new sessions only.
- Moving an active session is a separate migration command with a previewed key mapping and per-session result. No bulk “use latest” switch is available.

Track bindings can ask for domain evidence. They cannot edit rubric criteria/weights, decide admission, or grant an award. Track names and sponsor terms remain draft until the board approves them.

### Intake diagnostics

The health view shows:

- answer-save latency and save failures;
- active/complete/abandoned sessions by checkpoint, generated-question purpose, and fallback key;
- sessions by pinned catalog/flow/model version;
- intake Workpool depth and oldest job;
- model success, refusal, invalid-schema, question-policy rejection, timeout, rate-limit, stale-result, and deterministic-fallback rates;
- median and tail latency and bounded token usage by configuration version;
- aggregate question length, skip, duplicate, compound-question, and easy-answer evaluation rates by policy version.

Diagnostics never show participant answer text, generated brief text, contact information, system instructions, provider payloads, or API keys. Support can open a participant-authorised project record through the ordinary scoped route when content inspection is actually required.

## 5. Header

Every screen shows:

- event and active round;
- server time;
- dashboard connection state;
- production release ID;
- published track-catalog/intake-flow versions;
- number of unresolved critical exceptions;
- active incident banner;
- signed-in role and scope.

If the live subscription is stale, command controls disable and the page shows the last server update time.

## 6. Round control

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

Review-round check-in is not a participant hacking-session check-in. The attendance schedule and the judging round schedule may overlap but keep separate records and policy.

## 7. Attendance and presence

The attendance workspace opens on the active session, not a historical chart.

Summary cards show:

- expected and confirmed participants;
- currently present, temporarily out, departed, excused, and needs-review counts;
- participants whose confirmation window is closing;
- team review-readiness impact;
- zone occupancy and configured safe capacity;
- online, stale, offline, and replaying stations;
- accepted, duplicate, rejected, and pending throughput.

The live participant table can be filtered by session, zone, team, track, participant class, state, or support flag. A row shows preferred name, badge reference, team, current state, latest accepted server time, station, and coarse exception state. Sensitive reason detail stays inside the linked support case.

The session panel shows:

- published attendance-plan version and expected-cohort snapshot;
- expectation-build or closing/finalisation progress, processed count, needs-review count, and checksum state;
- scheduled and accepted actual start/end;
- check-in opening, grace, late-arrival, and away-alert settings;
- tracked zones and enabled scan methods;
- required, optional, or information-only status;
- minimum-duration/checkpoint rule when configured;
- session version and last protected change.

Operators can:

- open, extend, close, or cancel a session;
- activate, reconfigure, or disable a station;
- issue, revoke, or replace a participant credential;
- record an excused/accessibility exception;
- add a compensating event for a missed or incorrect scan;
- place or clear a short team review-readiness hold;
- open an emergency roll call;
- request a purpose-limited export.

The scan ledger is never edited from this screen. A correction previews the current event sequence, the compensating transition, affected intervals/results, actor, and required reason.

An emergency roll call creates a frozen starting snapshot and a continuing live view by zone. It separates confirmed inside, temporarily out, departed, unknown, excused, and not expected. New scans update the live view without changing the snapshot used to start the roll call.

The board does not rank participants by hours or label an ordinary temporary exit as misconduct. Long-away and missing-scan conditions are operational prompts until an authorised person applies the approved attendance policy.

Overlapping sessions are separate rows and per-participant states. A workshop confirmation cannot replace the broader hacking-session confirmation. The dashboard blocks open until expectation materialisation completes and keeps close visibly in progress until every resumable finalisation batch and count check succeeds.

## 8. Floor and tables

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

## 9. Reviewer and panel board

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

## 10. Queue board

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

## 11. Active reviews

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

## 12. Integration evidence and health

The integration view is team-scoped. Each row shows:

- provider, active GitHub repository count or Figma file state, and binding owner team;
- one GitHub child row per repository with kind, purpose, topic, tracked branch/root, baseline/head SHA, last push, last reconciliation, and completeness;
- Figma provider-last-touched, webhook-observed, metadata-checked, and full-content-captured times;
- current checkpoint-set IDs attached to each review;
- installation, webhook, authorization, access, rate-limit, and Workpool state;
- duplicate, out-of-order, truncated, stale, `content_dirty`, or reauthorization warnings.

Participant, reviewer, and operations screens read the same materialised status records. The dashboard does not calculate cards by scanning raw provider events.

Event administrators can request an idempotent reconciliation, request a full checkpoint, send a reauthorization prompt, disable a binding, or approve a documented shared-resource exception. An operator cannot reveal a token, change the captured evidence for an active review, or bypass provider backoff. Every manual retry and binding replacement keeps its actor and reason.

## 13. Scoring completeness

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

## 14. Support desk

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

Categories include identity, team, project intake, track/configuration, attendance credential, missing scan, scanner device, table, integration, queue, reviewer device, scorecard, accessibility, and safety.

A support case links to the relevant server records but grants no extra permissions.

## 15. Protected command rules

| Command | Minimum capability | Extra check |
| --- | --- | --- |
| Publish application decision | Admissions administrator | admission policy, review coverage, and capacity |
| Publish intake/track/model configuration | Event administrator | validation/evaluation pass, fresh session, diff, and reason |
| Migrate active intake sessions | Event administrator + named configuration authority | dry-run mapping, affected-session list, and reason |
| Promote waitlisted team | Admissions administrator | available confirmed-participant capacity |
| Publish attendance plan | Attendance lead/event administrator | validation, impact preview, fresh session, and reason |
| Open/extend/close/cancel attendance session | Attendance lead | current session version and consequence preview |
| Reconfigure active scan station | Attendance lead | registered device, affected queue, and reason |
| Replace participant credential | Attendance operator | participant match; old credentials revoked atomically |
| Reconcile participant presence | Attendance lead | fresh sign-in, linked source events, preview, and reason |
| Start emergency roll call | Attendance lead/incident commander | named incident or drill and zone snapshot |
| Export identifiable attendance | Event administrator/auditor scope | fresh sign-in, purpose, fields, and expiry |
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

## 16. Live updates and conflicts

Dashboard panels subscribe to small, indexed Convex queries. Attendance rows subscribe to individual projections and sharded counts rather than the raw scan ledger. A participant scan updates the participant, team availability, zone, active session, and roll-call views from the same accepted mutation. A panel row updates when its reviewer, queue, page, review, or exception records change.

The client may show an action as pending. It shows accepted only after the mutation returns.

Commands that can collide include a current record version. If another operator changed the target first, the server rejects the stale command and returns the new state. The UI asks the operator to review it rather than replaying the old action. Simultaneous NFC and QR scans for one participant return one accepted transition and one duplicate result.

High-impact commands also carry a client operation ID. Repeating the same request after a timeout returns the first accepted result.

## 17. Incident mode

An incident commander can post a banner with:

- affected service or venue zone;
- severity;
- instruction to participants/reviewers/staff;
- time opened and last updated;
- owner.

Round pause blocks new review starts but keeps active drafts available. Attendance incident mode can disable a station, redirect traffic, begin a roll call, and mark offline scans for later reconciliation. The dashboard has a printable emergency pack containing the current roster, last accepted zone/presence snapshot, station list, panel/table plan, active sessions, numbered attendance sheets, and serialised manual-review sheets. Printing the pack is restricted and audited.

Manual incident records are reconciled after recovery under the reliability procedure.

## 18. Privacy

- Floor views use preferred names and event identifiers, not eligibility documents.
- Phone numbers appear only to support/operations users who need to contact the person.
- Participant registration numbers do not appear on panel boards.
- Attendance views contain boundary events only; they do not show GPS, Bluetooth, Wi-Fi, or background location.
- An ordinary temporary exit stores no reason. Sensitive attendance exceptions stay in restricted support records.
- Team leads receive a regrouping summary, not another member’s movement timeline.
- Exact presence history and exports are available only to attendance leads, authorised event administrators, or auditors with a purpose.
- Attendance events never appear in project evidence, reviewer context, score calculations, or engagement leaderboards.
- Score values remain behind review-administrator or board capability.
- Raw provider tokens and session details never appear in the dashboard.
- Exports are purpose-labelled, time-limited, and logged.

## 19. Acceptance checks

- Two dashboards receive the same panel/queue change without refresh.
- NFC and QR scans update two attendance dashboards, the participant portal, and the relevant team/zone summary without refresh.
- A duplicate or simultaneous scan creates one presence transition and stable counters.
- Extending, closing early, or cancelling an attendance session preserves scan history and recalculates only derived results.
- A session with 1,000 expected people opens/closes through resumable indexed batches and never claims completion from a partial job.
- An attendance correction cannot edit or delete the original event and fails without a fresh session, linked evidence, and reason.
- An emergency roll call keeps its opening snapshot while displaying later live changes.
- A floor operator cannot read detailed attendance history or export attendance without the narrower capability.
- A published catalog has five core tracks; optional sponsor entries do not replace a team's core track.
- Every simulated intake path finishes when model output succeeds, times out, refuses, is invalid, or is disabled.
- Every published model policy generates three to five introduction follow-ups, respects the smaller bound for later phases, rejects unsafe or burdensome wording, and has a phase-appropriate deterministic fallback.
- Publishing a new flow does not change an active session, and migration cannot run without an exact preview.
- Intake diagnostics expose operational counts and versions without participant/model text.
- An application reviewer cannot read an unassigned application or a peer recommendation before submission.
- A published admission decision points to the reviewed project and admission-policy versions.
- A stale dashboard cannot overwrite a newer table or queue update.
- Floor operations can see missing scorecards without seeing score values.
- A delivered push never appears as substitute acceptance.
- Round close lists exact blocking sessions, criteria, and corrections.
- A board override fails without a fresh session and reason.
- Every after-freeze table move, manual queue priority, presence waiver, correction, and reopen appears in audit history.
- A disconnected or stale dashboard cannot submit commands.
- Participant, reviewer, and operations views agree on a team’s current integration snapshot and freshness.
- A manual provider retry is deduplicated, respects stored backoff, and cannot alter an active review’s evidence.
- No operations response or screen contains a GitHub installation token, Figma OAuth token, webhook secret, or raw credential record.

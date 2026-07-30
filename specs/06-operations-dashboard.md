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

Every route, query, and command checks a stable permission key against current person-specific grants. Role labels provide suggested default bundles and filters only. A Supreme user without a matching grant is denied; a JC, participant, or External Judge with the exact grant is allowed within its scope.

The dashboard is assembled from independent read/action permissions. Examples:

- `admissions.queue.read` for an event or assigned application set;
- `attendance.station.read` and `attendance.scan.execute` for one station;
- `review.queue.manage` for one round/panel;
- `score.completeness.read` without `score.values.read`;
- `integration.health.read` for an event, team, or integration;
- `records.export.identifiable` for one event and validity window.

There is no generic shared “admin mode,” role bypass, or wildcard permission.

### Permission manager

A user with `access.permissions.read` can inspect only the people/scopes covered by that grant. Search across the event requires separate event-scoped `access.people.lookup`. Grant controls require `access.permissions.grant_any` or one matching `access.permissions.grant_scoped`; revoke controls require the independent `access.permissions.revoke_any` or matching `access.permissions.revoke_scoped`.

Within those boundaries, the page lets the user:

1. find any event-linked person by name, verified email, participant record, or roster entry;
2. choose one atomic permission from the server-owned catalog;
3. choose one exact catalog-allowed scope, such as person, team, application, permission bundle, round, panel, review, attendance session, station, device, credential, zone, integration, support case, Synesthesia window, self, or an explicitly legal event-wide scope;
4. set start/end time and the constraint fields allowed for that permission;
5. enter a reason and preview the resulting effective access;
6. grant immediately or schedule the grant when grant authority matches;
7. revoke one grant, every grant from one assignment/bundle, or selected grants in an audited batch when revoke authority matches.

The page shows the optional role label, but never uses it to disable an otherwise legal grant. A verified account that is not yet linked to the event follows the separate `access.subjects.invite` flow first; the link assigns no role or permission. The page separates source grants—role template, participant/team membership, panel/station assignment, manual, or delegated—so removing one source does not accidentally remove another. Convenience bundles expand into individual rows before confirmation.

Role labels, rosters, and bundles are separate tools. `access.roles.assign`, `access.roster.import`, `access.permission_bundles.read`, `access.permission_bundles.publish`, `access.permission_bundles.apply`, and `access.permission_bundles.migrate` do not imply one another or direct grant/revoke authority. Bundle apply can be limited to one bundle, exact targets, scopes, and validity.

The UI labels delegation separately from execution. Being allowed to grant an action never lights up that action’s button unless the user also holds the action permission.

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

`admissions.application.assign`, `admissions.information.request`, `admissions.decision.prepare`, `admissions.decision.publish`, `admissions.offer.manage`, and `admissions.waitlist.promote` are separate grants. Every published decision keeps the application version, admission-policy version, reviewer recommendations, actor, permission grant, and time.

A submitted core-track change creates a new project version. If it affects reviewer assignment, a track quota, or an active offer, admissions receives a re-review/capacity blocker; the dashboard never moves the reservation silently.

The venue judging rubric and score views do not appear in this workspace.

## 4. Intake and track configuration

The configuration studio is permission-gated and is not mixed into live floor controls. Reading, drafting, validating, simulating, publishing, migrating active sessions, and rolling back are separate grants, so one person may prepare a version without being able to publish it.

The studio has six related editors:

1. **Track catalog:** exactly five core tracks in the working event policy, plus optional sponsor tracks, eligibility, disclosures, examples, domain tags, display order, and status.
2. **Event phases:** schedule-assigned `introduction`, `ideation`, `build`, `intermediate_update`, `review_ready`, and `final_update` definitions and checkpoint mappings.
3. **Intake shell:** the opening, first prompt, required confirmations, brief fields, answer limits, and deterministic fallback prompts.
4. **Question policy:** minimum three and maximum five generated introduction follow-ups, smaller bounds for later phases, allowed purpose keys, 140-character limit, easy-answer rules, skip behaviour, and prohibited topics.
5. **Track/phase guidance:** small guidance overlays and fallback-prompt bindings for a core/sponsor track at an event phase or checkpoint.
6. **Model contract:** approved model ID/snapshot, instruction/schema/evaluation versions, input/output limits, deadlines, retries, and no-tools/`store: false` requirements.

The opening preview must show only **Hello.**, followed by **What is your project about?** and one text box. A preview that renders a long form, chat transcript, assistant persona, or PPT upload cannot publish.

### Draft and publication

- Published versions are immutable. `configuration.draft.create` permits cloning one to make a draft.
- The validator checks stable keys, track count/types, every reference, the introduction's three-to-five question bound, later-phase bounds, generated-question policy, required-confirmation reachability, sponsor eligibility, and deterministic fallback coverage.
- The simulator runs representative project descriptions across every phase/core-track combination and sponsor overlay under model success, rejected-question, timeout, refusal, invalid-output, and disabled-model conditions.
- Publication samples generated paths for human review and requires the evaluation suite to meet thresholds for relevance, easy-answer rate, duplicate/compound-question rate, prohibited-topic/PII rate, average question length, and fallback rate.
- The diff lists participant-visible wording, routing, eligibility, submission requirements, retention/model settings, and the number of active sessions pinned to the previous version.
- Publication uses `configuration.publish`, a fresh session, summary, and reason. It updates defaults for new sessions only.
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
- signed-in role label and current page’s effective permission scope.

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
- reopen with `round.reopen`.

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

The live participant table can be filtered by session, zone, team, track, participant class, state, or support flag. A row shows preferred name, VIT registration or external event-badge reference where permitted, team, current state, latest accepted server time, station, and coarse exception state. Raw VIT card identifiers/fingerprints and sensitive reason detail never appear.

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
- enrol, suspend, or rebind a VIT ID card after a staffed identity check;
- issue, revoke, or replace an external QR badge;
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
- add a missing-presence waiver with `review.presence.waive` for that review;
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

Reconciliation, full-checkpoint request, reauthorization prompt, binding disablement, and shared-resource override use separate integration permission keys at event/team/integration scope. No permission reveals a provider token, changes captured evidence for an active review, or bypasses provider backoff. Every manual retry and binding replacement keeps its actor, permission grant, and reason.

## 13. Scoring completeness

A separate scoring-governance view requires `score.completeness.read`; opening numeric values additionally requires `score.values.read`. It contains:

- expected scorecards by team and reviewer;
- criteria covered and missing;
- submitted time;
- score-spread flags;
- conflicts;
- correction requests;
- invalidated or replacement reviews;
- round total only when complete.

The default view shows completeness, not a winner leaderboard during active reviews.

`scorecard.correction.open`, `scorecard.void`, and `score.release` are independent grants. None permits typing over a submitted score.

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

| Command | Required permission | Extra check |
| --- | --- | --- |
| Link existing account to event | `access.subjects.invite` | exact event and existing person resolved by confirmed verified email; validity ceiling, fresh session, and reason |
| Suspend event access subject | `access.subjects.suspend` | exact target-person/event scope; impact preview, fresh session, and reason |
| Reactivate event access subject | `access.subjects.reactivate` | exact target-person/event scope; fresh session and reason; grants are not recreated |
| Assign or replace a role label | `access.roles.assign` | exact target-person/event scope; fresh session and reason; role grants no access |
| Import roster | `access.roster.import` | exact event scope; validated rows, bundle previews, fresh session, and importer reason |
| Publish permission bundle | `access.permission_bundles.publish` | exact bundle/event scope; catalog validation, diff, fresh session, and reason |
| Apply permission bundle | `access.permission_bundles.apply` | exact bundle scope; target-person boundary, resolved scopes/expiry, and atomic-grant preview |
| Migrate bundle-sourced grants | `access.permission_bundles.migrate` | exact bundle/event scope; source-only diff, target set, access versions, fresh session, and reason |
| Grant one permission | `access.permissions.grant_any` or matching `access.permissions.grant_scoped` | exact target, catalog key, resource scope, constraints, validity, preview, fresh session, and reason |
| Revoke permission grant(s) | `access.permissions.revoke_any` or matching `access.permissions.revoke_scoped` | exact target/grant scope, source impact, access version, fresh session, and reason |
| Publish application decision | `admissions.decision.publish` | application/event scope; admission policy, review coverage, and capacity |
| Publish intake/track/model configuration | `configuration.publish` | configuration/event scope; validation/evaluation pass, fresh session, diff, and reason |
| Migrate active intake sessions | `configuration.active_session.migrate` | configuration/event scope; dry-run mapping, affected-session list, fresh session, and reason |
| Promote waitlisted team | `admissions.waitlist.promote` | event/track scope; available confirmed-participant capacity |
| Publish attendance plan | `attendance.plan.publish` | event scope; validation, impact preview, fresh session, and reason |
| Open/extend/close/cancel attendance session | `attendance.session.manage` | exact attendance-session scope; current version and consequence preview |
| Reconfigure active scan station | `attendance.station.manage` | exact station scope; registered device, affected queue, and reason |
| Enrol VIT ID card | `attendance.credential.enrol` | event/station scope; VIT membership, visible card/account match, uniqueness, and repeat read |
| Rebind VIT ID card | `attendance.credential.rebind` | event/person scope; fresh authentication, identity match, reason, and atomic suspension |
| Replace external QR badge | `attendance.badge.replace` | participant/event scope; participant match and atomic old-bearer revocation |
| Reconcile participant presence | `attendance.presence.reconcile` | participant/session scope; fresh sign-in, linked source events, preview, and reason |
| Start emergency roll call | `attendance.roll_call.start` | event/zone scope; named incident or drill and frozen zone snapshot |
| Export identifiable attendance | `attendance.export.identifiable` | event/session scope; fresh sign-in, purpose, fields, and expiry |
| Change table after freeze | `venue.table.move_after_freeze` | team/round scope; reason |
| Move queued team | `review.queue.move` | team/round/panel scope; reason and current queue version |
| Assign substitute manually | `review.substitute.assign` | panel/round scope; eligibility and conflict check |
| Waive judge presence | `review.presence.waive` | review scope; fresh sign-in and reason |
| Extend beyond ordinary allowance | `review.timer.extend_exception` | review scope; fresh sign-in and reason |
| Open score correction | `scorecard.correction.open` | scorecard/review scope; correction window and reason |
| Void scorecard | `scorecard.void` | scorecard/review scope; evidence and replacement decision |
| Close round | `round.close` | exact round scope; no unresolved blockers |
| Reopen closed round | `round.reopen` | exact round scope; fresh sign-in and reason |
| Export identifiable records | `records.export.identifiable` | explicit event/resource scope; fresh sign-in and export purpose |

High-impact commands show the current value, proposed value, affected records, and reason before submission.

## 16. Live updates and conflicts

Dashboard panels subscribe to small, indexed Convex queries. Attendance rows subscribe to individual projections and sharded counts rather than the raw scan ledger. A participant scan updates the participant, team availability, zone, active session, and roll-call views from the same accepted mutation. A panel row updates when its reviewer, queue, page, review, or exception records change.

The client may show an action as pending. It shows accepted only after the mutation returns.

Commands that can collide include a current record version. If another operator changed the target first, the server rejects the stale command and returns the new state. The UI asks the operator to review it rather than replaying the old action. Simultaneous VIT ID and portal-QR scans for one participant return one accepted transition and one duplicate result.

High-impact commands also carry a client operation ID. Repeating the same request after a timeout returns the first accepted result.

## 17. Incident mode

A named incident commander is an assignment, not a role boundary. Assigning any event-linked person materialises incident-scoped permissions such as `incident.banner.manage`, `round.pause`, and the explicitly approved recovery actions. A person with `incident.banner.manage` can post:

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
- Exact presence history requires `attendance.history.read` at the relevant person/session scope; identifiable exports require a separate export grant and purpose.
- Attendance events never appear in project evidence, reviewer context, score calculations, or engagement leaderboards.
- Score values require `score.values.read` at the relevant round/review scope.
- Raw provider tokens and session details never appear in the dashboard.
- Exports are purpose-labelled, time-limited, and logged.

## 19. Acceptance checks

- Two dashboards receive the same panel/queue change without refresh.
- VIT ID card and QR scans update two attendance dashboards, the participant portal, and the relevant team/zone summary without refresh.
- A duplicate or simultaneous scan creates one presence transition and stable counters.
- Extending, closing early, or cancelling an attendance session preserves scan history and recalculates only derived results.
- A session with 1,000 expected people opens/closes through resumable indexed batches and never claims completion from a partial job.
- An attendance correction cannot edit or delete the original event and fails without a fresh session, linked evidence, and reason.
- An emergency roll call keeps its opening snapshot while displaying later live changes.
- A person with floor-summary or scan permission cannot read detailed attendance history or export attendance without the separate scoped grants.
- A published catalog has five core tracks; optional sponsor entries do not replace a team's core track.
- Every simulated intake path finishes when model output succeeds, times out, refuses, is invalid, or is disabled.
- Every published model policy generates three to five introduction follow-ups, respects the smaller bound for later phases, rejects unsafe or burdensome wording, and has a phase-appropriate deterministic fallback.
- Publishing a new flow does not change an active session, and migration cannot run without an exact preview.
- Intake diagnostics expose operational counts and versions without participant/model text.
- `application.review.read` for one application cannot read an unassigned application or a peer recommendation before submission.
- A published admission decision points to the reviewed project and admission-policy versions.
- A stale dashboard cannot overwrite a newer table or queue update.
- Floor operations can see missing scorecards without seeing score values.
- A delivered push never appears as substitute acceptance.
- Round close lists exact blocking sessions, criteria, and corrections.
- An override permission fails outside its exact scope or without its required fresh session and reason.
- A role label with no grants opens no protected dashboard route.
- A manually granted permission works for any event-linked user regardless of role and exposes only its selected resource scope.
- Revoking that grant closes the route on the next server query/write even if the browser still displays a cached navigation item.
- Applying a convenience bundle displays and creates every underlying atomic grant; changing the bundle is not retroactive.
- Granting and revoking require separate permissions; holding either cannot perform the other operation.
- Grant authority does not unlock the underlying protected action.
- A scoped grant/revoke delegator cannot act outside its one permission key, resource-scope ceiling, target-person boundary, or expiry ceiling.
- Every after-freeze table move, manual queue priority, presence waiver, correction, and reopen appears in audit history.
- A disconnected or stale dashboard cannot submit commands.
- Participant, reviewer, and operations views agree on a team’s current integration snapshot and freshness.
- A manual provider retry is deduplicated, respects stored backoff, and cannot alter an active review’s evidence.
- No operations response or screen contains a GitHub installation token, Figma OAuth token, webhook secret, raw VIT card identifier/fingerprint, or raw QR credential.

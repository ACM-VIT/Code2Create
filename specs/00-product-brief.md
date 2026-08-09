# Product brief

## 1. Problem

Code2Create 7.0 needs to run reviews for a 48-hour event with roughly 900–1,000 people in one venue.

The planning discussion identifies the failures to prevent:

- reviewers were missing, asleep, or at the wrong place when a panel needed them;
- panel composition did not consistently match the work being reviewed;
- teams did not know when or where their review would happen;
- reviewers opened a review without enough project or previous-round context;
- one strong voice could dominate a panel;
- scores moved through messages and spreadsheets, then arrived late or went missing;
- organizers found problems after delays had already spread across the floor.

The product is an event operating system for that review process. It connects participant preparation, floor queues, reviewer work, judging records, and staff intervention.

## 2. Users

| User | Needs |
| --- | --- |
| Participant | Clear registration, team state, project submission, session attendance, staff-managed queue position, and review progress |
| Team lead | Control of team membership, project versions, and tool connections before the applicable locks |
| Supreme | Suggested permission-administration and broad event-governance bundle |
| Board | Suggested policy, admissions, rubric, results, correction, export, and override bundle |
| SC | Suggested workflow-management bundles for selected operational scopes |
| JC | Suggested frontline station, table, queue, support, verification, runner, or playback bundles |
| External Judge | Suggested assigned-panel context, presence, and own-scorecard bundle |

These are the only staff/judging role labels. Supreme, Board, SC, and JC are the four internal labels. External Judge is a separate label. Roles never authorize a protected function. Every permission is an atomic grant to one person. Each grant has an exact scope and validity window. Any event-linked person can receive a permission regardless of role. A specifically invited account can have no role label. Granting and revoking are separate scoped permissions. Operational bundles and assignments only materialize or revoke their own explicit grants.

## 3. Product surfaces

### Participant portal

The responsive participant portal provides these functions:

- Google sign-in;
- a class-aware basic profile;
- live team formation;
- one-prompt-at-a-time project intake;
- fresh-project attestation;
- core-track choice and optional sponsor-track opt-in;
- the final team/track lock;
- admission status;
- short responses from the locked lead when admissions requests more information;
- team-lead offer response and selected-team next steps;
- GitHub/Figma connections;
- attendance status and dynamic QR;
- a separate confirmed-team hall-location QR;
- staff-managed queue status with a coarse wait estimate;
- self-service support cases;
- review history; and
- Synesthesia.

One immutable participant-policy version controls profile collection and team eligibility. The portal shows only the fields that the policy permits. The portal records acceptance of the exact version. Before a relevant write commits, the server rechecks the current version, team-size bounds, mixed-team rule, and lock warning. A later publication updates open portals and requires explicit acceptance. It never rewrites an earlier profile or submitted project snapshot.

Final submission also resolves one immutable admission release. Before applications begin, authorized operations users publish the complete year-adjusted rubric. They also publish the human-review minimum, human decision reasons, and participant capacity. The release contains either one exact admission-model release or an explicit human-only mode. The first submitted application freezes the release for the event. Publication cannot split teams across rubrics or reset capacity after admissions begins.

An authenticated exact-team query returns the selected-team venue, dates, ordered next steps, and Discord. These values come from one current immutable communications policy. The public event payload does not contain these values. Important status email remains generic and pins the policy version that rendered it. The signed-in portal follows later publications in realtime.

Project intake begins with **Hello.** and **What is your project about?** Committing the answer immediately opens track selection. The full track list remains available. A server-side OpenAI layer can highlight one track. It generates at most one or two short, relevant follow-up questions. Each question is supportive. The team can answer each question from its current intent without research or pitch preparation. A restrained cherry-blossom motif can identify the event without decorative clutter. The model produces no authoritative participant, admission, or judging state. Deterministic fallback prompts keep the same flow usable when the model is unavailable.

While the participant writes the first answer, a separate debounced embedding path compares the current text with an immutable curated corpus of past Code2Create projects. The path atomically returns a directional `0–100` novelty signal, one approved nearest-theme label, and one supportive reflection prompt. The browser never renders a result for older text. The system does not disclose raw past-project text. The system excludes the signal from application submission, admissions, queues, judging, and awards.

### Reviewer app

The dedicated Expo reviewer application provides Google sign-in, device registration, reviewer clock-in, pages, QR scans, review context, score drafts, submission, self-service support cases, and support for short connection loss. Provisioned staff devices also provide a capability-gated camera scanner for VIT ID barcodes and attendance QR. Review and scan controls use large targets and little text.

### Operations dashboard

The permission-gated operations dashboard opens on a quiet, ordered event-health view. Event setup shows the current state and only its legal next action: open applications, close applications, start the event, or finish it. Each action names unfinished setup before it can run. Viewing and changing the state use independent grants. It provides separately permitted workspaces for support, rehearsal, attendance, Synesthesia, review, score, integration, admissions, and access. The live review board shows each team's current inside/active count. It rechecks the published minimum before a call or start. Only a freshly authenticated holder of the exact-team/review permission can record a reasoned exception. The rehearsal workspace turns the 61 release scenarios into one live run. The run has named workstream owners, expected states, recovery actions, append-only outcomes, and a separate final sign-off. Assigning an owner routes responsibility but grants no access. The health view shows bounded aggregate blockers and the next owner. It does not expose the underlying incident, participant, repository, or provider details. A separately granted operator can request a short brief from the frozen redacted view. The brief cites the health signals that it used and provides no control. Corrective commands remain inside their own exact permission boundaries.

Admissions operators first configure the complete admission release. Separate grants control read, draft, validation, and publication actions. Operators then route an application to an exact active event account. The assignment creates only the application's review read/write grants and a personal realtime work item. Profile/year context, AI recommendation access, decisions, and offers remain separate permissions. A direct manual review grant remains valid without a role or routing record. An authorized human can request one or two specific missing facts instead of making a terminal decision. Only the locked lead can answer. The roster and tracks remain locked. The response creates a new immutable application-content version before human review and optional AI review run again.

## 4. Event model

The working event model has two ordinary reviews followed by a final round. The elimination schedule is still open.

A normal review follows this sequence:

1. The team confirms the project brief produced from its guided intake and connects any declared GitHub or Figma work.
2. Operations confirms the team’s venue table.
3. The review desk verifies the locked team/project, current operational blockers, and panel constraints. The review desk then places the team directly into an eligible panel queue.
4. Participants receive the queue, call, table, hold, and review state in realtime. They cannot enqueue the team themselves.
5. All assigned panel reviewers prove presence by scanning the review-presence team QR.
6. The server starts the review and records one start time.
7. Reviewers inspect the project and score their assigned criteria independently.
8. Each reviewer submits a complete scorecard.
9. The panel review completes after all required scorecards and commitments are present.
10. The next review receives the previous review’s evidence, findings, and commitments, but not hidden peer scores.

An operations user can handle a missing reviewer, team hold, table move, scan failure, or correction. Every exception requires a named permission and a reason.

## 5. Scope

### Included

- Google sign-in and participant classification;
- staff/reviewer roster claims, role defaults, and person-specific scoped permission grants;
- participant, team, and project onboarding;
- a fresh-project rule, configurable event checkpoints, sequential intake, five core-track positions, and optional sponsor-track eligibility;
- a versioned participant novelty corpus, native 1,536-dimension `text-embedding-3-small` comparison, and independently permissioned corpus operations;
- a final submission confirmation that atomically locks team membership, the confirmed core track, and the selected sponsor-track set;
- pre-event human application review, a structured year-adjusted AI recommendation, a one-or-two-question locked-lead information loop, shortlist, waitlist, capacity-backed offer, locked-lead confirmation, selected-team next steps, Discord handoff, and participant notifications;
- one-time venue check-in, configurable hacking-session attendance, existing VIT ID barcode scanning, external/fallback QR, temporary exit/re-entry, review-presence QR, and hall-location QR;
- reviewer expertise, conflicts, panels, and substitute paging;
- a published hall plan, staff-scanned team-location mapping, staff-controlled routing, and queues;
- timed reviews and reviewer presence;
- versioned rubrics, criterion assignments, scorecards, and progress commitments;
- team-scoped multi-repository GitHub/Figma resources, declared repository kinds, live progress facts, full checkpoint sets, exact-version private frame previews, and reviewer evidence views;
- live operations views and controlled overrides;
- a separate durable intelligence Worker whose first shipped job creates a bounded, evidence-linked operations brief from the current aggregate health projection;
- scoped support cases shared in realtime across participant, event-app, and operations views;
- audit history, round exports, backups, and incident procedures;
- one scoped release-rehearsal record covering every required scenario and final sign-off;
- two-person paper recovery for an already-started review, preserving each signed reviewer scorecard and the fixed review context;
- a restricted, expiring emergency pack that freezes the current participant/presence roster, stations, active sessions, panels, and uniquely numbered paper-recovery forms;
- Synesthesia requests, voting, moderation, and playback control.

### Excluded from the first production release

- sponsor CRM, speaker outreach, marketing, and ticket sales;
- mandatory problem statements for every team;
- AI-generated judging scores or score recommendations;
- automatic cross-panel score normalization;
- review audio recording or transcription;
- Bluetooth, mesh, or peer-to-peer data transport;
- a participant mobile application;
- a public social feed or engagement-points system.

## 6. Product rules

- The server owns assignments, queues, review state, and submitted scores.
- Attendance scans are participant-scoped facts. Session policy interprets them without editing the scan ledger.
- Venue arrival, current zone presence, and hacking-session confirmation are distinct states.
- A temporary exit, missing scan, or long break cannot change a judging score or automatically disqualify a participant.
- Reviewers cannot see peer scores before the configured reveal point.
- A reviewer scores only the criteria assigned to that reviewer.
- A designated panel coordinator cannot replace the panel’s independent scorecards with one consensus number.
- A reviewer’s designation does not multiply their score.
- The routing service uses declared expertise, conflict checks, availability, and load. It does not use an AI model to decide winners or scores.
- Convex is the only event authority. An agent may observe a purpose-built projection or draft a proposed next step, but it cannot hold a broad service credential, impersonate a user, or call an event command.
- An agent proposal never carries authority. A future executable proposal must return through the ordinary UI. It must name its source and current target version. A human must confirm the proposal. The normal Convex mutation must recheck the human's exact permission, scope, fresh-session requirement, and current state.
- The intake model may generate one bounded follow-up at a time, identify missing fields, and recommend one published track. Participants provide every answer and choose the track; a different choice has no adverse admission effect.
- The live novelty signal is a drafting aid only. It may invite differentiation, but it cannot block submission, enter an application or reviewer view, change an admission recommendation, or become a judging score.
- A separate admission-analysis model may produce a structured recommendation against the published year-adjusted application rubric. It cannot publish or silently change an application decision, and it cannot set or recommend a judging score.
- Admission policy, optional admission-model configuration, and the initial overall capacity bucket publish in one transaction. The first submitted application permanently closes ordinary publication for that event. Publication racing submission has one serial winner. The application pins the winner's exact policy.
- The final application command requires an explicit preview of the active members, track, and project summary and locks membership and track in the same transaction.
- A participant-facing queue gives teams ahead and a time window. It does not promise an exact start minute.
- Support is a diagnostic route only. A linked team, attendance session, queue, review, scorecard, or owner creates no authority and changes no underlying domain state.
- A timer is calculated from the server start time. Clients do not write a database record every second.
- A push notification asks a reviewer to open the app. The in-app page must still be accepted.
- A score submission is accepted only after a server response. Local storage cannot claim success.

## 7. Scale assumptions

The venue count is confirmed. Final team and reviewer counts are not.

Until registration closes, capacity tests use this provisional envelope:

- 1,200 simultaneous live client connections;
- 60 attendance scan attempts per second across provisioned stations during a session-opening burst;
- 200–330 teams, depending on final team-size rules;
- up to 60 reviews running at once;
- a burst of 300 participant reconnects or queue-status reads around a round start;
- 150 operational writes per minute during the busiest review window.

The rehearsal must replace these figures with the registered team count, panel count, and round schedule.

## 8. Outcomes

The launch is acceptable when:

- every published admission decision can be traced to its project/policy versions and independent recommendations;
- every AI admission recommendation can be traced to the published year-adjusted policy and reviewed inputs, and every final outcome to a human actor who used, cleared, or overrode it;
- every submitted application in one event points to the same frozen admission policy, and an enabled model pointer always belongs to that policy;
- active offers and confirmations stay within approved venue capacity;
- staffed arrival records the identity check for each accepted member, exposes a bounded live count, and never implies venue presence or hacking-session attendance;
- operations can distinguish who is confirmed present, temporarily out, departed, excused, or unresolved for each active hacking session;
- VIT ID barcode and QR scans update the same participant, team, zone, and emergency-roll-call projections without duplicate presence intervals;
- operations can locate every clocked-in reviewer and see each unfilled panel seat;
- a missing reviewer produces an acknowledged substitute or a visible unresolved exception;
- every started review has the required presence record or an explicitly permitted, reasoned presence waiver;
- participants can see whether they are waiting for the review desk, queued, called, held, in review, or complete;
- participants and reviewers can open and reply to only their own support cases, while separately granted staff receive only the exact cases and actions their read/manage scopes cover;
- a submitted scorecard can be recovered after an app restart or an ambiguous network response;
- a round cannot close while required scorecards or criterion coverage are missing;
- later reviewers can see previous commitments and checkpoint evidence;
- every protected correction identifies the actor, target, previous value, new value, time, and reason;
- a project application can be completed when OpenAI is unavailable, and its submitted summary preserves the participant-written idea and follow-up answers;
- a stale live novelty request cannot replace a newer result, sensitive text creates no embedding request, and novelty failure never blocks saving or submitting the idea;
- a selected team can read venue/date/next steps and its locked team/project summary, open the published Discord route, and receive an important-status notification without keeping the portal open;
- only a team that confirms its live offer can enter attendance, hall-mapping, or review-queue flows;
- a full adjudicated round export can reproduce every selected total, pin exact private object versions, and reach `closed` only after a different authorized person opens and verifies it;
- reopening preserves the verified revision and requires another export/verification cycle before the round can close again;
- a paper review cannot enter judging state until a different authorized person verifies the protected source, and its imported scorecard versions remain visibly tied to that paper record.
- an authorized incident operator can prepare and print one reproducible emergency snapshot without gaining any other attendance, score, or permission-administration capability.
- an authorized release owner can identify the person who ran each required rehearsal scenario and the recorded result. The owner can also identify each recovery, rerun, and final signer after all 61 scenarios passed.
- an authorized operations reader can request a brief that cites only current aggregate signals, cannot reveal protected source records, and cannot perform the actions it lists.
- a team below the round's participant minimum stays queued or cannot start. Presence must recover, or one exact and freshly authenticated person must record an immutable review-specific exception. The exception changes no attendance or judging state.

## 9. Policy versus software

The software must support versioned event configuration for these values:

- team size and team/track lock wording;
- attendance sessions and cohorts;
- check-in windows, tracked zones, temporary-exit alerts, and excused attendance;
- rounds, review duration, extension count, rubric, and criterion coverage;
- queue policy and correction windows;
- track catalogs and event checkpoints;
- intake generation policy;
- the curated novelty corpus and similarity thresholds;
- track/checkpoint guidance and common-idea reflection patterns;
- deterministic fallback prompts and the bounded intake-model contract;
- the year-adjusted admission rubric/model contract;
- participant communications; and
- any enabled intelligence automation policy.

Event owners must approve those values before production data opens. A missing policy remains a launch blocker; engineers do not choose it inside client code.

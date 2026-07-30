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
- organisers found problems after delays had already spread across the floor.

The product is an event operating system for that review process. It connects participant preparation, floor queues, reviewer work, judging records, and staff intervention.

## 2. Users

| User | Needs |
| --- | --- |
| Participant | Clear registration, team state, project submission, session attendance, review readiness, queue position, and review progress |
| Team lead | Control of team membership, project versions, tool connections, and ready state |
| Supreme | Final event authority, internal-role control, destructive recovery approval, and exceptional release/override actions |
| Board | Policy, configuration, admissions, rubric, results, protected exports, and named emergency decisions |
| SC | Duty-scoped control of admissions review, attendance, venue, panels, queues, support, integrations, release, or Synesthesia |
| JC | Duty-scoped station, table, queue, runner, support, verification, or playback work |
| External Judge | One current panel assignment, enough context, a timer, assigned criteria, an independent scorecard, and fast recovery |

These are the only staff/judging roles. Supreme, Board, SC, and JC are the four internal levels; External Judge is separate from that hierarchy. Work such as attendance control, application review, incident command, release ownership, panel coordination, and Synesthesia moderation is a temporary duty or assignment, not another role. Participant and team-lead access comes from event/team membership.

## 3. Product surfaces

### Participant portal

A responsive web application handles Google sign-in, participant classification, team formation, a one-prompt-at-a-time project intake, fresh-project attestation and track confirmation, admission status, GitHub/Figma connections, attendance status and dynamic QR, team QR, readiness, queue status, review history, and Synesthesia.

Project intake begins with **Hello.** and **What is your project about?** The interface stays visually static and minimal while a server-side OpenAI layer identifies already answered fields and generates three to five short, relevant follow-up questions. Each question is designed to be answerable from the team's current intent without research or pitch preparation. The model produces no authoritative participant or judging state, and the same flow remains usable through deterministic fallback prompts when it is unavailable.

### Reviewer app

A dedicated Expo application handles Google sign-in, device registration, reviewer clock-in, pages, QR scans, review context, score drafts, submission, and short connection loss. Provisioned staff devices also expose a capability-gated attendance scanner using native NFC or the camera. Review and scan controls use large targets and little text.

### Operations dashboard

A role-gated web application shows attendance sessions, participant presence, scanner health, rounds, panels, tables, queues, reviewer presence, pages, live timers, missing scorecards, conflicts, and exceptions. It also exposes emergency roll call and the protected commands used to correct event state.

## 4. Event model

The working event model has two ordinary reviews followed by a final round. The elimination schedule is still open.

A normal review follows this sequence:

1. The team confirms the project brief produced from its guided intake and connects any declared GitHub or Figma work.
2. Operations confirms the team’s venue table.
3. The team lead marks the team ready.
4. The routing service assigns the team to an eligible panel and queue.
5. All assigned panel reviewers prove presence by scanning the team QR.
6. The server starts the review and records one start time.
7. Reviewers inspect the project and score their assigned criteria independently.
8. Each reviewer submits a complete scorecard.
9. The panel review completes after all required scorecards and commitments are present.
10. The next review receives the previous review’s evidence, findings, and commitments, but not hidden peer scores.

An operations user can handle a missing reviewer, team hold, table move, scan failure, or correction. Every exception requires a named permission and a reason.

## 5. Scope

### Included

- Google sign-in and participant classification;
- staff/reviewer roster claims and event roles;
- participant, team, and project onboarding;
- a fresh-project rule, configurable event checkpoints, sequential intake, five core-track positions, and optional sponsor-track eligibility;
- pre-event application review, shortlist, waitlist, offer, and confirmation;
- one-time venue check-in, configurable hacking-session attendance, existing VIT ID card scanning, external/fallback QR, temporary exit/re-entry, and team QR;
- reviewer expertise, conflicts, panels, and substitute paging;
- table assignment, readiness, routing, and queues;
- timed reviews and reviewer presence;
- versioned rubrics, criterion assignments, scorecards, and progress commitments;
- team-scoped multi-repository GitHub/Figma resources, declared repository kinds, live progress facts, full checkpoint sets, and reviewer evidence views;
- live operations views and controlled overrides;
- audit history, round exports, backups, and incident procedures;
- Synesthesia requests, voting, moderation, and playback control.

### Excluded from the first production release

- sponsor CRM, speaker outreach, marketing, and ticket sales;
- mandatory problem statements for every team;
- AI-generated judging scores or score recommendations;
- automatic cross-panel score normalisation;
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
- The intake model may generate a bounded follow-up question, identify missing fields, and suggest published tracks. Participants provide every answer and confirm track choices; the model cannot submit, admit, reject, route, or score a team.
- A participant-facing queue gives teams ahead and a time window. It does not promise an exact start minute.
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
- a burst of 300 participant reconnects or ready/queue reads around a round start;
- 150 operational writes per minute during the busiest review window.

The rehearsal must replace these figures with the registered team count, panel count, and round schedule.

## 8. Outcomes

The launch is acceptable when:

- every published admission decision can be traced to its project/policy versions and independent recommendations;
- active offers and confirmations stay within approved venue capacity;
- operations can distinguish who is confirmed present, temporarily out, departed, excused, or unresolved for each active hacking session;
- VIT ID card and QR scans update the same participant, team, zone, and emergency-roll-call projections without duplicate presence intervals;
- operations can locate every clocked-in reviewer and see each unfilled panel seat;
- a missing reviewer produces an acknowledged substitute or a visible unresolved exception;
- every started review has the required presence record or a board override;
- participants can see whether they are not ready, queued, called, held, in review, or complete;
- a submitted scorecard can be recovered after an app restart or an ambiguous network response;
- a round cannot close while required scorecards or criterion coverage are missing;
- later reviewers can see previous commitments and checkpoint evidence;
- every protected correction identifies the actor, target, previous value, new value, time, and reason;
- a project application can be completed when OpenAI is unavailable, and every generated brief field can be traced to participant-written answer versions;
- a full round export can be generated and checked before the next round starts.

## 9. Policy versus software

The software must support versioned event configuration for team size, attendance sessions and cohorts, check-in windows, tracked zones, temporary-exit alerts, excused attendance, rounds, review duration, extension count, rubric, criterion coverage, queue policy, correction windows, track catalogs, event checkpoints, intake generation policy, track/checkpoint guidance, deterministic fallback prompts, and the bounded model contract.

Event owners must approve those values before production data opens. A missing policy remains a launch blocker; engineers do not choose it inside client code.

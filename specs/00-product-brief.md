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
| Participant | Clear registration, team state, project submission, review readiness, queue position, and review progress |
| Team lead | Control of team membership, project versions, tool connections, and ready state |
| Application reviewer | A focused pre-event project application and an independent admission recommendation |
| Admissions administrator | Eligibility, reviewer coverage, shortlist/waitlist decisions, offers, and venue capacity |
| Reviewer | One current assignment, enough context, a timer, assigned criteria, an independent scorecard, and fast recovery |
| Panel lead | Panel readiness and completion without access to edit another reviewer’s score |
| Review operations | Live queues, absent reviewers, substitutes, panel coverage, and review exceptions |
| Event administrator | Event configuration, rosters, round control, corrections, and protected exports |
| Board member | Narrow emergency overrides and final-decision access |
| Auditor | Read-only history of decisions, changes, and exceptions |

One person may hold several event roles. Each role is granted for a named event and checked by the backend.

## 3. Product surfaces

### Participant portal

A responsive web application handles Google sign-in, participant classification, team formation, guided project questions, admission status, GitHub/Figma connections, check-in, team QR, readiness, queue status, review history, and Synesthesia.

### Reviewer app

A dedicated Expo application handles Google sign-in, device registration, clock-in, pages, QR scans, review context, score drafts, submission, and short connection loss. Review controls use large targets and little text.

### Operations dashboard

A role-gated web application shows rounds, panels, tables, queues, reviewer presence, pages, live timers, missing scorecards, conflicts, and exceptions. It also exposes the protected commands used to correct event state.

## 4. Event model

The working event model has two ordinary reviews followed by a final round. The elimination schedule is still open.

A normal review follows this sequence:

1. The team completes the required project profile and connects any declared GitHub or Figma work.
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
- pre-event application review, shortlist, waitlist, offer, and confirmation;
- venue check-in and team QR;
- reviewer expertise, conflicts, panels, and substitute paging;
- table assignment, readiness, routing, and queues;
- timed reviews and reviewer presence;
- versioned rubrics, criterion assignments, scorecards, and progress commitments;
- GitHub and Figma progress snapshots;
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
- Reviewers cannot see peer scores before the configured reveal point.
- A reviewer scores only the criteria assigned to that reviewer.
- A panel lead cannot replace the panel’s independent scorecards with one consensus number.
- A reviewer’s designation does not multiply their score.
- The routing service uses declared expertise, conflict checks, availability, and load. It does not use an AI model to decide winners or scores.
- A participant-facing queue gives teams ahead and a time window. It does not promise an exact start minute.
- A timer is calculated from the server start time. Clients do not write a database record every second.
- A push notification asks a reviewer to open the app. The in-app page must still be accepted.
- A score submission is accepted only after a server response. Local storage cannot claim success.

## 7. Scale assumptions

The venue count is confirmed. Final team and reviewer counts are not.

Until registration closes, capacity tests use this provisional envelope:

- 1,200 simultaneous live client connections;
- 200–330 teams, depending on final team-size rules;
- up to 60 reviews running at once;
- a burst of 300 participant reconnects or ready/queue reads around a round start;
- 150 operational writes per minute during the busiest review window.

The rehearsal must replace these figures with the registered team count, panel count, and round schedule.

## 8. Outcomes

The launch is acceptable when:

- every published admission decision can be traced to its project/policy versions and independent recommendations;
- active offers and confirmations stay within approved venue capacity;
- operations can locate every clocked-in reviewer and see each unfilled panel seat;
- a missing reviewer produces an acknowledged substitute or a visible unresolved exception;
- every started review has the required presence record or a board override;
- participants can see whether they are not ready, queued, called, held, in review, or complete;
- a submitted scorecard can be recovered after an app restart or an ambiguous network response;
- a round cannot close while required scorecards or criterion coverage are missing;
- later reviewers can see previous commitments and checkpoint evidence;
- every protected correction identifies the actor, target, previous value, new value, time, and reason;
- a full round export can be generated and checked before the next round starts.

## 9. Policy versus software

The software must support versioned event configuration for team size, rounds, review duration, extension count, rubric, criterion coverage, queue policy, and correction windows.

Event owners must approve those values before production data opens. A missing policy remains a launch blocker; engineers do not choose it inside client code.

# Product brief

## 1. Purpose

Code2Create 7.0 is a 48-hour event for about 900 to 1,000 people in one venue.

The product controls participant registration, proposal intake, admission, attendance, review operations, judging records, and staff response. Convex is the authority for event state. All clients read accepted state from the realtime backend.

The product must prevent these failures:

- A reviewer is absent or assigned to the wrong team.
- A panel does not have the required expertise.
- A team does not know its current review state.
- A reviewer starts without the required project and review context.
- One reviewer replaces independent panel scores with one consensus score.
- A score or operational decision is lost in a message or spreadsheet.
- Staff learn about a blocker after it has delayed other teams.

## 2. Actors

| Actor          | Main work                                                                                                       |
| -------------- | --------------------------------------------------------------------------------------------------------------- |
| Participant    | Maintain a profile, join a team, submit a proposal, attend sessions, follow review state  |
| Team lead      | Manage membership, transfer leadership, revise the proposal, answer admission questions, and connect team tools |
| Supreme        | Hold suggested event-governance grants                                                                          |
| Board          | Hold suggested policy, admission, rubric, result, correction, export, and override grants                       |
| SC             | Hold suggested workflow-management grants for assigned scopes                                                   |
| JC             | Hold suggested station, table, queue, support, verification, runner, or playback grants                         |
| External Judge | Hold assigned-panel, presence, and own-scorecard grants                                                         |

The only role labels are `Supreme`, `Board`, `SC`, `JC`, and `External Judge`. Protected functions never authorize from the label itself; each action requires an atomic permission grant for one person, one scope, and one validity window. Assigning Supreme atomically materializes its code-owned role template only when the assigner can grant every permission in that template. A person can still receive a grant without a role label.

## 3. Product surfaces

### Participant portal

The participant portal is a Vite web application. It provides:

- Google sign-in;
- VIT-student and external-participant profiles;
- realtime team formation and leadership transfer;
- free-text proposal intake;
- two fixed proposal questions followed by two useful AI-attempted follow-ups;
- a non-blocking live novelty number above the idea text box;
- proposal submission and revision;
- admission status and offers;
- team-scoped GitHub and Figma connections;
- venue and session attendance status;
- a personal attendance QR when required;
- a separate review-presence QR;
- staff-managed review-queue state;
- support cases;
- review history; and
- Synesthesia music requests and votes.

One published participant-policy version controls profile fields, team bounds, notices, consent text, and the final-submission warning. VIT students and external participants always form separate teams. Each participant accepts the exact current policy version. A later publication does not rewrite an earlier profile, proposal version, or consent record.

The proposal starts with **What is your project about?** The team writes free text. The server stores that text, then asks two published questions: **What problem are you solving, and who has it?** and **How will your solution work in practice?** Both require answers. The system then fills two more required slots. It attempts one short, grounded AI question for each slot. If a slot does not settle within 20 seconds, or generation is unavailable or invalid, the system shows that slot's published fallback question. The team therefore always answers four questions. A late model result cannot replace a visible fallback. The AI cannot choose participant state, admission state, review state, or judging state.

The live novelty feature is separate from the follow-up-question flow. It shows only one directional number from 0 through 100 above the idea text box. It has no label such as familiar or distinct. It shows no prior-project text, theme, or reflection prompt. A stale or failed request cannot block editing or submission. The number is absent from applications, admission analysis, human admission review, reviewer evidence, judging, awards, and exports.

Final submission sends the current team and proposal for review. Team membership, leadership, and proposal content remain editable until the deadline for the team's participant class. Every accepted change creates a new immutable application version. A post-submission team or proposal change makes all earlier human-review outputs and AI admission outputs stale. The system must create new review inputs before a human can publish a decision for the changed application. At the applicable deadline, the latest valid team and proposal version becomes final.

### Reviewer app

The reviewer app is a dedicated Expo application. The project builds and signs native binaries locally. The event distributes updates from its own Cloudflare Worker and R2 service.

The app provides Google sign-in, device registration, clock-in, pages, notification registration, consented phone-call escalation, review-presence scanning, attendance scanning on provisioned devices, review context, independent scorecards, support, and short connection-loss recovery.

Reviewer paging uses a reusable outbound-calling service. The service sends push first. If push is unavailable, it can call immediately. Otherwise, the first unanswered reminder can add one synthesized call; its delay is half the response window, capped at 30 seconds. The reviewer must give active consent. The platform records consent, dispatch, provider results, page responses, cancellation before claim, and the page chain's authorizing grants. Team leads can separately opt into next-team and ready-for-review calls using their saved profile phone. Reviewer shift reminders use an ops-configured lead time (default 300 seconds, 0 disables), with an optional call at the same time for reviewers who confirm the updated review-call notice. Clock-in and changed availability prevent obsolete reminders.

### Operations dashboard

The operations dashboard is a separate Vite web application. It provides permission-scoped workspaces for event setup, access, applications, admission, panels, reviewer paging, attendance, queues, reviews, judging, integrations, support, incidents, rehearsal, and Synesthesia.

The dashboard shows accepted state and legal next actions. Each protected command rechecks the caller's exact permission, target scope, current version, and current authorization requirement in the mutation that writes the result.

## 4. Core workflows

### Application

1. Each participant signs in with Google and completes the permitted profile fields.
2. A participant creates or joins one team.
3. The team maintains exactly one lead. Leadership transfer requires acceptance by the new lead.
4. The team writes its proposal and answers two fixed questions followed by two AI-attempted questions or their published fallbacks.
5. The lead previews the active member list and current proposal.
6. Final submission creates the first immutable team and proposal snapshot.
7. The team can change membership or leadership, and the lead can revise the proposal, until the deadline for that team's participant class.
8. Each accepted change creates a new immutable application version and invalidates stale human-review and AI-admission outputs.
9. Authorized humans review the current version and control the admission decision.
10. The system sends generic status email. The authenticated portal shows the decision and next steps.

### Venue and attendance

1. Staff scan the barcode on a VIT student's existing VIT ID from a provisioned phone.
2. Staff scan the static event pass for an external participant. An authorized manual registration-number or verified-email lookup is available only as a staffed first-check-in fallback.
3. The server records one-time venue arrival separately from session presence.
4. The server records session entry, temporary exit, return, and final exit as participant-scoped facts.
5. The participant and operations views update from the same accepted records.
6. Attendance does not change admission, review scores, or awards.

### Review

1. Operations assigns the team to an eligible panel queue.
2. Participants receive queue, call, table, hold, and review state in realtime.
3. Assigned reviewers prove presence by scanning the team's review-presence QR.
4. The server starts the review and records one authoritative start time.
5. Reviewers inspect the proposal, project evidence, and permitted prior-review context.
6. Each reviewer scores only assigned criteria and submits an independent scorecard.
7. The review completes after all required scorecards and commitments are present.
8. The next review receives released evidence, findings, and commitments. It does not receive hidden peer scores.

## 5. Admission and judging boundary

Admission and judging are separate systems.

An admission model can return a structured recommendation against the published admission policy. The recommendation is advisory. It cannot publish a decision, reserve capacity, change team state, or write a judging score. An authorized human records whether the human used, cleared, or overrode the recommendation.

Judging uses the published judging rubric, reviewer assignments, independent scorecards, and approved corrections. Judging does not use the novelty number or an AI admission recommendation. No AI can write or recommend a judging score.

## 6. Integrations and hosting

- Convex is the realtime backend and event authority.
- The participant portal and operations dashboard use Vite. Repository Markdown is the handbook source, with a separate private reader.
- The backend is a separate application.
- Google and Better Auth provide sign-in.
- A team can connect multiple GitHub repositories across installations and organizations.
- Each GitHub repository keeps its own tracked branch, purpose, baseline, snapshots, and health.
- A team can connect one or more Figma files through scoped OAuth.
- Cloudflare Workers handle approved external service boundaries.
- The event-owned mail service sends participant email through the provider pinned in the published policy: Amazon SES or Cloudflare Email Sending. Cloudflare Email Routing retains the inbound support alias.
- Protected exports and previews use approved private S3 storage. Expo Update manifests and assets use the event-owned R2 service.
- Expo Update manifests and assets come from the event-owned Cloudflare Worker and R2 service.
- The product does not use EAS Build, EAS Update, or Expo Push Service.

## 7. Product rules

- The server owns assignments, queues, review state, attendance state, and submitted scores.
- A client shows success only after an accepted server response.
- Realtime views derive from accepted records.
- Support links do not grant access to the linked domain record.
- A permission bundle creates explicit grants. It does not add hidden authority.
- An assignment creates only its declared grants. Revocation removes only grants from that source.
- A model output never carries authority.
- GitHub and Figma activity is evidence. It is not a score and does not prove individual contribution.
- Attendance is an operational fact. It is not a score and does not automatically disqualify a participant.
- A queue estimate is a range. It is not an appointment.
- A push notification or phone call asks a reviewer to open the app. The reviewer must acknowledge the in-app page.
- A score submission is accepted only after the server confirms it.

## 8. Production capacity

The online application round is planned for up to 2,000 participants across the
submission window. Capacity decisions use the published team-size limits and the
actual application schedule. Realtime presence exists only while a participant
has the portal open; registered participants are not treated as simultaneous
connections.

Participant saves and final submission do not depend on model or embedding
capacity. Novelty may temporarily show **Unavailable**. Each generated question
slot settles with a validated model question or its published fallback within
the product deadline. Production keeps the backend and provider limits recorded
in the deployment inventory and monitors deadline-window traffic separately.

## 9. Acceptance outcomes

The production release must satisfy these outcomes:

- Every application decision points to the current immutable proposal version and admission-policy version.
- A proposal revision before `applicationsCloseAt` makes earlier review and AI outputs unusable.
- No proposal edit is accepted after `applicationsCloseAt`.
- Team membership, leadership, and proposal content remain editable after submission until the applicable class deadline.
- Every accepted post-submission team change creates a new immutable roster and proposal snapshot and invalidates stale review and AI output.
- Every final admission outcome identifies the authorized human actor.
- Active offers and confirmations do not exceed approved participant capacity.
- VIT ID barcode and QR scans update one participant identity without duplicate presence intervals.
- Operations can distinguish venue arrival, session presence, temporary exit, departure, excusal, and unresolved state.
- An authorized organizer can map a team from the team's dashboard QR.
- Operations can locate clocked-in reviewers and unfilled panel seats.
- A missing reviewer creates a visible page and escalation record.
- Phone escalation requires current consent and a scoped permission.
- Every started review has the required reviewer-presence record or a permitted, reasoned waiver.
- Participants see the same queue and review state that operations accepted.
- A submitted scorecard survives app restart and ambiguous network responses.
- A round cannot close while required scorecards or criterion coverage are missing.
- Every correction records actor, target, previous value, new value, time, and reason.
- The application flow remains usable when OpenAI is unavailable.
- The novelty number cannot block admission or affect judging.
- GitHub supports multiple repositories for one team.
- Figma evidence is pinned to exact file versions for review.
- Cloudflare-hosted email and Expo Updates do not depend on EAS services.

## 10. Required policy decisions

Board and the named owners must publish these values before the applicable release gate:

- team-size rules;
- the external-participant and VIT-student application deadlines;
- participant profile fields, notices, and consent text;
- fresh-project and pre-start-work rules;
- admission criteria, human-review minimum, model policy, capacity, waitlist order, and offer deadline;
- reviewer eligibility, panel size, and expertise coverage;
- round schedule, rubric, correction deadline and award rules;
- attendance sessions, expected groups, grace windows, and result policy;
- reviewer page timeout, push policy, call script, consent text, provider rate limits, and retention;
- GitHub and Figma requirements and accepted alternatives;
- support categories, retention, and privacy periods;
- Synesthesia catalog, request limits, moderation rules, and playback windows; and
- incident, backup, rehearsal, and launch sign-off owners.

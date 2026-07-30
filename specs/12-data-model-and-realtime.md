# Data model and realtime

## 1. Conventions

- Convex document IDs are the internal references.
- Every event-scoped record contains `eventId`, even when it can be reached through another record. This keeps authorization and indexes direct.
- Server time is stored as Unix milliseconds in UTC. Event display uses the configured IANA timezone.
- Mutable operational records contain an integer `version`.
- Status replaces deletion for event, judging, audit, and integration records.
- Submitted project and scorecard versions are immutable.
- Client-provided IDs are never trusted without loading the referenced record and checking event ownership.
- Live queries use indexes. A function does not scan a whole table and filter in memory.

## 2. Authentication data

The Better Auth Convex component owns its generated auth schema:

- users;
- provider accounts;
- sessions;
- verification/state records.

Application functions access auth through the Better Auth/Convex helpers. Business queries do not read auth tables directly.

The application keeps only the identity link and event data it needs.

## 3. Identity and access tables

### `people`

One application person per Better Auth user.

Key fields:

- `authUserId`
- `googleSubject`
- `verifiedEmail`
- `displayName`
- `status: active | suspended | merged`
- `mergedIntoPersonId?`
- `createdAt`, `updatedAt`

Indexes:

- unique-by-mutation `by_auth_user`
- unique-by-mutation `by_google_subject`
- `by_verified_email`

### `authIntents`

Short-lived participant selector state.

Key fields:

- `eventId`
- `nonceHash`
- `requestedClass: vit_student | external`
- `returnPath`
- `expiresAt`
- `consumedAt?`
- `consumedByPersonId?`

Store a nonce hash, not the bearer nonce.

### `eventMemberships`

One person’s participation in one event.

Key fields:

- `eventId`, `personId`
- `participantClass: vit_student | external | none`
- `eligibilityStatus: pending | eligible | rejected | suspended`
- `onboardingStatus`
- `googleHostedDomain?`
- `createdAt`, `updatedAt`

One active membership exists per event/person.

### `roleGrants`

Time-bound application authorization.

Key fields:

- `eventId`, `personId`
- `role`
- `scopeType: event | round | panel | team | synesthesia`
- `scopeId?`
- `validFrom`, `validUntil`
- `status: active | revoked | expired`
- `sourceType: roster | administrator | board`
- `sourceId`
- `grantedByPersonId`
- `revokedAt?`, `revokeReason?`

### `rosterEntries`

Reviewer/staff invitations.

Key fields:

- `eventId`
- `emailNormalized`
- `displayName`
- `role`, `scopeType`, `scopeId?`
- `validFrom`, `validUntil`
- `status: unclaimed | claimed | disabled`
- `linkedPersonId?`
- `importBatchId`
- `claimedAt?`

Claiming an entry and creating its role grant happen in one mutation.

### `devices`

Reviewer installations.

Key fields:

- `eventId`, `personId`
- `installationId`
- `platform: ios | android`
- `appBuild`, `runtimeVersion`
- `pushToken?`, `pushTokenUpdatedAt?`
- `status: active | revoked | replaced`
- `notificationPermission`
- `cameraPermission`
- `lastSeenAt`

A notification token may move between records only through the token-refresh function.

### `participantProfiles`

Event registration details.

Key fields:

- `eventId`, `membershipId`
- common profile fields;
- VIT registration/programme/campus fields when applicable;
- external institution/eligibility fields when applicable;
- accepted policy versions;
- `profileVersion`
- `updatedAt`

Sensitive eligibility evidence, if required, is stored as a protected file reference rather than embedded in this record.

## 4. Event configuration

### `events`

- name, slug, timezone;
- registration/check-in/event windows;
- status;
- active participant, project-form, admission, security, retention, and Synesthesia configuration IDs;
- hosted-domain allowlist;
- active incident ID;
- production release metadata.

### `eventConfigVersions`

Versioned non-round policy.

- `eventId`;
- `kind: participant_policy | project_form | admission_policy | security | retention | synesthesia`;
- version number;
- typed configuration payload for that kind;
- `status: draft | published | superseded`;
- published actor/time;
- checksum.

The admission payload contains minimum application reviewers, venue/track capacity, waitlist ordering, offer expiry, and decision-publication rules. The project-form payload contains stable question keys and limits. Published versions are immutable.

### `rounds`

- `eventId`, sequence, name;
- check-in/open/close windows;
- `status: draft | check_in | open | paused | closing | closed`;
- table-freeze time;
- review duration and extension policy;
- missed-call and queue policy values;
- panel-plan ID;
- rubric-version ID;
- `version`;
- opened/closed actor and time.

A closed round points to its export manifest and cannot change without reopen.

### `rubricVersions`

- `eventId`
- version number and status;
- 0–4 scale anchors;
- ordered criterion array with stable key, label, guidance, weight, round applicability;
- minimum independent scorers per criterion;
- score-spread threshold;
- aggregation formula identifier;
- published actor/time.

The criterion array is frozen after publication. Scorecards store its version ID and stable criterion keys.

## 5. Teams and projects

### `teams`

- `eventId`
- name and public code;
- lead membership ID;
- `status: forming | profile_in_progress | submitted | admitted | confirmed | checked_in | active | completed | withdrawn | disqualified`;
- join-code hash and rotation time;
- `version`;
- created/updated time.

### `teamMembers`

- `eventId`, `teamId`, `membershipId`
- `role: lead | member`
- `status: invited | active | left | removed`
- joined/left time and source.

The mutation that adds an active member first queries `by_event_membership_status`, preventing a person from joining two active teams in the same event.

### `teamInvites`

- `eventId`, `teamId`
- token hash;
- expiry and maximum uses;
- status and use count;
- creator.

### `projectDrafts`

One mutable draft per team.

- `eventId`, `teamId`
- project-form configuration ID;
- answer map keyed by stable question key;
- selected track;
- declared tools/prior work;
- current GitHub/Figma connection IDs;
- `version`, last editor, updated time.

### `projectVersions`

Immutable submission snapshots.

- `eventId`, `teamId`
- project version number;
- copied answers/disclosures/links;
- track;
- project-form and participant-policy configuration IDs;
- source draft version;
- submitted by/at;
- supersedes project version ID when applicable.

### `applications`

One pre-event application per team/event.

- `eventId`, `teamId`;
- submitted project-version ID;
- admission-policy configuration ID;
- `state: submitted | under_review | needs_information | selected | waitlisted | rejected | offer_sent | confirmed | offer_expired | withdrawn`;
- assigned-review count and completed-review count;
- published decision, reason code, actor, and time;
- current offer ID;
- `version`.

Changing project answers after an information request updates the application to the new submitted version and keeps the previous reference in history.

### `applicationReviews`

- `eventId`, `applicationId`, `teamId`;
- reviewed project-version ID;
- reviewer person ID;
- assignment time;
- `state: assigned | submitted | void`;
- recommendation `select | waitlist | reject | needs_information`;
- reason codes and note;
- admission-policy configuration ID;
- submitted/void actor and time.

One active review exists per application/reviewer. Peer recommendations stay out of the reviewer query until submission.

### `admissionOffers`

- `eventId`, `applicationId`, `teamId`;
- offered participant count;
- offer/promotion source;
- sent and expiry time;
- `state: offered | confirmed | declined | expired | revoked`;
- confirmed member IDs;
- decision actor/time;
- `version`.

Sending an offer reserves participant capacity in the same mutation. Confirmation locks the accepted member set. Expiry, decline, or revocation releases the reservation.

### `checkIns`

- `eventId`, `membershipId`
- desk/zone;
- checked-in actor and time;
- badge reference;
- status and reversal reason.

One active check-in exists per membership/event.

### `tables`

- `eventId`
- zone and label;
- accessibility attributes;
- `status: open | closed | reserved`;
- floor-map coordinates or display order.

### `teamTableAssignments`

- `eventId`, `roundId`, `teamId`, `tableId`
- `status: proposed | confirmed | frozen | superseded`
- source and confidence/report state;
- team confirmation/mismatch time;
- `version`;
- assigned actor/time.

One frozen assignment exists per team/round.

## 6. Review setup

### `reviewerProfiles`

- `eventId`, `personId`
- domain and track tags;
- criterion keys;
- languages;
- reviewer type for staffing;
- training state;
- availability windows;
- current operational state.

### `reviewerConflicts`

- `eventId`, `reviewerPersonId`
- `teamId?`, `organisation?`, conflict category;
- visibility-safe label and restricted details;
- source and review status;
- created/resolved actor/time.

The routing query uses only active confirmed conflicts.

### `reviewerClockIns`

- `eventId`, `roundId`, `reviewerPersonId`, `deviceId`
- `status: expected | present | temporarily_unavailable | clocked_out | no_show`
- availability end;
- last heartbeat;
- reason and actor for operator changes;
- `version`.

### `panelPlans`

- `eventId`, `roundId`
- version number;
- status `draft | published | superseded`;
- coverage/configuration summary;
- created and published actor/time.

### `panels`

- `eventId`, `roundId`, `panelPlanId`
- label, table/zone;
- lead reviewer;
- `status: planned | ready | needs_reviewer | active | paused | retired`;
- current active session ID;
- `version`.

### `panelMembers`

- `eventId`, `roundId`, `panelId`
- reviewer person ID;
- seat label;
- assigned criterion keys;
- `status: planned | active | replaced | removed`;
- source type and source page ID;
- assignment start/end.

An active reviewer cannot occupy overlapping panel seats in the same round.

## 7. Live round state

### `teamRoundStates`

One operational record per team/round.

- `eventId`, `roundId`, `teamId`
- `state: not_ready | ready | queued | called | at_table | in_review | completed | held | missed | withdrawn`
- table-assignment ID;
- panel ID and assignment time;
- queue-entry ID;
- active/completed review-session ID;
- ready/called/arrived/completed times;
- QR token version and expiry;
- fallback-code hash;
- blocker and public message key;
- `version`.

This record drives participant status and prevents two active routes for one team.

### `queueEntries`

- `eventId`, `roundId`, `panelId`, `teamRoundStateId`, `teamId`
- `state: queued | called | at_table | in_review | completed | held | missed | moved`
- `priorityBand`
- server-generated `sortKey`
- ready/queued/called times;
- manual-priority reason and actor;
- previous/next panel when moved;
- `version`.

The live queue index is `by_panel_state_sort_key`.

### `pages`

One reviewer response request.

- `eventId`, `roundId`, `panelId`, seat label;
- target reviewer;
- reason;
- `state: sent | opened | accepted | declined | expired | cancelled`;
- created/deadline/opened/responded times;
- response reason;
- page-chain ID and rank;
- accepted assignment ID;
- `version`.

The first accepted page in a chain closes competing pages in the same mutation.

### `reviewSessions`

- `eventId`, `roundId`, `teamId`, `teamRoundStateId`, `panelId`, `tableId`
- `status: waiting_presence | active | overdue | completing | completed | void`;
- server `startedAt`;
- base duration and extension seconds;
- project-version ID;
- GitHub/Figma snapshot IDs;
- rubric-version and panel-plan IDs;
- criterion-assignment snapshot;
- completed/void actor, time, reason;
- `version`.

Unique-by-mutation checks prevent another active session for the team/round or panel.

### `reviewPresence`

- `eventId`, `roundId`, `sessionId`
- reviewer person ID and device ID;
- method `qr | fallback_code | board_override`;
- token version;
- confirmed time;
- override actor/reason when applicable.

One presence record exists per session/reviewer.

### `reviewCommitments`

- `eventId`, `sessionId`, `teamId`
- ordered commitment items;
- shared findings;
- next checkpoint;
- entered by and confirmed time;
- `version`.

## 8. Scorecards

### `scorecards`

One working scorecard per session/reviewer.

- `eventId`, `roundId`, `sessionId`, `teamId`, `reviewerPersonId`
- assigned criterion keys;
- rubric-version ID;
- evidence values;
- criterion values `{ key, score, note }`;
- private note;
- `state: draft | submitted | correction_open | superseded | void`;
- `draftVersion`;
- current submitted-version ID;
- last saved device/time.

### `scorecardVersions`

Immutable submitted copies.

- `eventId`, `roundId`, `scorecardId`
- version number;
- copied evidence, criterion values, and private note;
- assigned criteria and rubric-version ID;
- submitted actor/time;
- submission operation ID;
- correction-case ID and superseded version ID when applicable;
- aggregate input checksum.

### `evaluationResults`

Server-computed round result for one team.

- `eventId`, `roundId`, `teamId`, `sessionId`;
- rubric-version ID;
- `state: incomplete | complete | invalidated`;
- criterion results with input scorecard-version IDs, mean, and weighted points;
- total points;
- missing coverage and spread flags;
- input checksum;
- computed/invalidated time and reason.

The result is rebuilt from immutable scorecard versions after submission or correction. It is a cache with traceable inputs, not a replacement for raw scores.

### `correctionCases`

- `eventId`, `roundId`
- target type and ID;
- requested by/time;
- category and reason;
- `state: requested | approved | rejected | resubmitted | closed`;
- approver, decision, and time;
- original/new version IDs.

No correction deletes a submitted version.

## 9. Operations, incidents, and audit

### `operationResults`

Keeps the result of a high-impact client operation.

- `eventId`, `actorPersonId`
- client operation ID;
- command name;
- target reference;
- accepted result summary;
- created and expiry time.

The unique lookup is `(actorPersonId, clientOperationId)`. Entries can expire after the event’s audit/recovery window.

### `supportCases`

- `eventId`, optional round/team/person/session references;
- public support code;
- category, description, reporter;
- owner;
- `state: open | investigating | waiting | resolved | closed`;
- action log and timestamps.

### `incidents`

- `eventId`
- severity, affected area/service;
- participant/reviewer/staff message;
- commander and owner;
- `state: open | monitoring | resolved`;
- opened/updated/resolved times;
- manual-mode approval references.

### `manualReviewRecords`

- `eventId`, `roundId`, `teamId`, `panelId`
- paper serial;
- scanned file ID;
- copied presence, times, rubric version, raw ratings, and commitments;
- first entry actor/time;
- verifier actor/time;
- state and reconciliation notes;
- resulting review/scorecard IDs.

### `exportManifests`

- `eventId`, `roundId`;
- export version and `state: generating | uploaded | verified | failed`;
- rubric, panel-plan, admission-policy, and release IDs;
- team/session/scorecard/manual-record counts;
- generated file keys, sizes, and SHA-256 checksums;
- S3 bucket/key prefix;
- generated, uploaded, and verified actor/time;
- failure category.

Round close points to the verified manifest.

### `auditEvents`

Append-only protected history.

- `eventId`
- actor person/role/device;
- action;
- target type/ID;
- previous and next summary;
- reason;
- incident/support/correction reference;
- server time;
- release ID.

Indexes support event/time and target/time lookup.

## 10. Integration tables

### `integrationConnections`

- `eventId`, `teamId`
- provider `github | figma`;
- external account/installation/resource IDs;
- tracked GitHub branch and optional root path when provider is GitHub;
- display name and URL;
- granted scopes;
- status and last successful check;
- connected/revoked actor/time;
- credential ID where required.

### `integrationCredentials`

- `eventId`, `connectionId`
- encrypted token/refresh token;
- key version;
- provider expiry;
- status.

GitHub installation access tokens are not stored here; they are minted when needed. Figma OAuth tokens are encrypted here.

### `providerEvents`

- provider and delivery ID;
- event type;
- installation/resource reference;
- signature-check result;
- received/processed time;
- processing status and failure category.

Raw provider payloads are not retained by default.

### `integrationSnapshots`

- `eventId`, `teamId`, provider, connection ID;
- checkpoint type `connected | review_start | round_close | manual_refresh`;
- round/review references;
- provider resource version;
- captured time and provider source time;
- sanitised summary;
- stale/error state;
- previous snapshot ID.

GitHub summary can contain tracked branch, head SHA, commit count since previous snapshot, contributor IDs/logins, additions/deletions, and top changed paths. Figma summary can contain file version, last touched time, and named versions since the previous snapshot.

### `externalJobs`

- `eventId`
- kind `github_refresh | figma_refresh | push_send | push_receipt | export_upload`;
- deduplication key;
- target reference;
- `state: pending | running | retry | succeeded | failed`;
- attempt count, next attempt, last error category;
- created/finished time.

Job payloads reference protected records instead of copying secrets into the job.

### `notificationDeliveries`

- `eventId`, page/message ID, device ID;
- Expo ticket ID;
- provider receipt status;
- sent/checked time;
- terminal error and token-disable time.

## 11. Synesthesia tables

### `synesthesiaWindows`

Event window, request/vote state, content policy, limits, and priority rule version.

### `songRequests`

Requester, provider track ID, display metadata, moderation/playback state, vote count, priority fields, and moderator reason.

### `songVotes`

One active record per request/person with created/removed time.

### `playbackEvents`

Request, action `start | finish | skip | pause`, operator, provider reference, reason, and server time.

## 12. Required indexes

| Index | Purpose |
| --- | --- |
| `people.by_auth_user` | Resolve the current person |
| `authIntents.by_nonce_hash` | Consume one OAuth intent |
| `eventMemberships.by_event_person` | Resolve participant access |
| `rosterEntries.by_event_email_status` | First staff/reviewer claim |
| `roleGrants.by_event_person_status` | Authorize a current request |
| `eventConfigVersions.by_event_kind_status` | Resolve published event policy |
| `teamMembers.by_event_membership_status` | Prevent two active teams |
| `projectVersions.by_team_version` | Load exact reviewer context |
| `applications.by_event_state` | Admission queues and capacity |
| `applicationReviews.by_application_reviewer` | One independent review per reviewer |
| `applicationReviews.by_reviewer_state` | Application reviewer queue |
| `admissionOffers.by_event_state_expiry` | Capacity and waitlist promotion |
| `reviewerConflicts.by_event_reviewer_team_status` | Remove ineligible assignments |
| `reviewerClockIns.by_round_status` | Panel readiness and substitutes |
| `panelMembers.by_round_reviewer_status` | Prevent overlapping panel seats |
| `teamRoundStates.by_round_team` | One team state per round |
| `teamRoundStates.by_round_state` | Ready/held/completed operations lists |
| `queueEntries.by_panel_state_sort_key` | Ordered panel queue |
| `pages.by_reviewer_state_deadline` | Reviewer Now and expiry |
| `reviewSessions.by_round_team_status` | Prevent duplicate active review |
| `reviewSessions.by_panel_status` | One active team per panel |
| `reviewPresence.by_session_reviewer` | One scan per assigned reviewer |
| `scorecards.by_session_reviewer` | One working scorecard per reviewer |
| `scorecardVersions.by_scorecard_version` | Immutable submission history |
| `evaluationResults.by_round_state_total` | Complete ranking and round close |
| `integrationSnapshots.by_team_provider_time` | Compare checkpoints |
| `operationResults.by_actor_operation` | Resolve ambiguous writes |
| `exportManifests.by_round_version` | Round export and verification |
| `auditEvents.by_event_time` | Event audit |
| `auditEvents.by_target_time` | Object history |

“Unique” behaviour is enforced by querying the index and writing inside one Convex transaction. Concurrent mutations that read the same index range are retried by Convex.

## 13. Realtime projections

### `viewer.bootstrap`

Returns person, active memberships/grants, event, required next step, device requirements, and allowed route. It does not return raw roster or provider records.

### `participant.home`

Returns participant/team/project completion, application/admission state, official table, team QR reference, current `teamRoundState`, queue summary, commitments, and integration health.

### `admissions.reviewQueue`

Returns only the current application reviewer’s assigned application versions and own submitted recommendations.

### `admissions.capacity`

Returns application/review coverage, decisions, active offer reservations, confirmed participant counts, and remaining capacity. Detailed personal data requires a narrower query.

### `reviewer.now`

Returns clock-in state, active panel seat, current page, active session summary, save state, and next action. It returns one reviewer’s work only.

### `reviewer.activeContext`

Returns the fixed project/rubric/integration context for the assigned active session and that reviewer’s scorecard.

### `operations.roundBoard`

Returns round state, panel summaries, team-state counts, critical exceptions, and stale timestamps. Detail opens through separate indexed queries.

### `operations.scoreCompleteness`

Returns required/submitted scorecard and criterion counts plus flags. Score values and `evaluationResults` require another capability and query.

Subscriptions update only when records read by the query change. Screens use stable IDs and preserve local focus while data refreshes.

## 14. Command surface

| Area | Main commands |
| --- | --- |
| Identity | create auth intent, provision participant, claim roster, revoke grant, register/revoke device |
| Team/project | create/join/leave team, transfer lead, save draft, submit version, connect/disconnect integration |
| Admissions | assign application, submit own recommendation, request information, publish decision, send/respond/expire offer, promote waitlist |
| Venue | check in participant, assign/freeze table, report mismatch |
| Round/panel | publish plan, clock in, mark unavailable, page substitute, accept/decline page |
| Queue/review | set ready, route, call, hold, move, scan presence, start, extend, complete |
| Score | save own draft, submit own scorecard, request/approve correction, resubmit, void |
| Operations | pause/resume round, resolve support case, approve manual mode, import/verify paper record, close/reopen round |
| Integration | receive webhook, request checkpoint, retry/disable connection |
| Synesthesia | request, vote, moderate, acknowledge playback |

Each command has one server implementation used by web and mobile. A mobile-specific API does not apply different judging rules.

## 15. Concurrency cases

### Two team joins

Both mutations query active membership by event/person. One commits; the other retries and returns “already in a team.”

### Two substitute acceptances

Both load the page chain and empty panel seat. The first fills it and closes the chain. The second retries against the filled seat and receives the accepted reviewer identity permitted for that screen.

### Two review starts

The mutation checks team-round state and active sessions for team and panel. A duplicate operation returns the existing session; a different stale request fails.

### Two queue moves

The first updates queue and team-round versions. The second expected-version check fails and returns the current location.

### Score draft from old device

The patch carries expected `draftVersion`. A stale patch is not merged into the current value. The reviewer sees local and server copies and resolves through the active device/support process.

### Lost submit response

The client queries `operationResults` with the original submission ID. It receives the submitted version or a definite rejection before retrying.

### Round close during late submission

The close mutation checks incomplete scorecards/corrections in the same transaction. A concurrent valid submission either commits first and is included, or sees the closing/closed state and follows policy.

## 16. Data retention

The event board must set exact periods. The schema supports separate policies:

- auth sessions and expired intents;
- participant contact/eligibility data;
- project versions;
- provider credentials;
- integration snapshots;
- reviewer private notes;
- submitted scorecards and audit events;
- support/incident records;
- Synesthesia requests/votes;
- exports/backups.

Provider credentials should be deleted soon after the last required checkpoint and any complaint window. Revoking a connection marks snapshots as historical and removes usable tokens.

Operational judging records use status/versions rather than hard deletion during the event and complaint window.

## 17. Schema acceptance

- Cross-event IDs fail authorization even when the caller has the same role in another event.
- A participant cannot hold two active team memberships.
- One application reviewer cannot submit two active recommendations for the same application.
- Active offered/confirmed admission records cannot reserve more participants than approved capacity.
- One team and one panel cannot enter two active review sessions.
- One reviewer cannot occupy overlapping active seats.
- One reviewer/session produces one scorecard with immutable submitted versions.
- Every complete evaluation result names the exact immutable scorecard versions used.
- Round close cannot race past a required scorecard.
- Live participant, reviewer, and operations views derive from the same operational records.
- Provider credentials never appear in project, snapshot, job, query, audit, or error payloads.
- A backup/restore and round export preserve every relation needed to reproduce totals and exception history.

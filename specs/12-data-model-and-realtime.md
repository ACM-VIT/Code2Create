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
- active participant, intake-policy, admission, integration, security, retention, and Synesthesia configuration IDs;
- active track-catalog, intake-flow, and intake-model-configuration version IDs;
- hosted-domain allowlist;
- active incident ID;
- production release metadata.

### `eventConfigVersions`

Versioned non-round policy.

- `eventId`;
- `kind: participant_policy | intake_policy | admission_policy | integration_policy | security | retention | synesthesia`;
- version number;
- typed configuration payload for that kind;
- `status: draft | published | superseded`;
- published actor/time;
- checksum.

The admission payload contains minimum application reviewers, overall and optional core-track capacity, track-change re-review rules, waitlist ordering, offer expiry, and decision-publication rules. The intake-policy payload contains editing/submission windows, answer limits, allowed checkpoint types, and the required core-track count. The integration payload contains the active-repository cap, required topic, repository-kind enum version, checkpoint schedule, and refresh budgets. Published versions are immutable.

### `trackCatalogVersions`

One immutable catalog release.

- `eventId`, version number;
- `status: draft | published | superseded | retired`;
- required core-track count, initially five;
- published actor/time;
- checksum.

A published catalog contains exactly the configured number of core tracks and zero or more sponsor tracks. New names, eligibility, or prompt bindings require a new catalog version.

### `trackVersions`

- `eventId`, `catalogVersionId`;
- stable key, slug, display name, description, examples, and display order;
- `type: core | sponsor`;
- `status: draft | published | retired`;
- eligibility rules and required disclosure keys;
- allowed event-phase/checkpoint keys;
- domain/routing tags;
- sponsor identity, required-tool/use condition, and award-policy reference when type is `sponsor`;
- optional capacity-policy reference;
- checksum.

Stable keys are unique inside a catalog. Examples help a team understand an area; they are not mandatory problem statements. A track record contains no rubric weights.

### `intakeFlowVersions`

One versioned intake shell shared by application and later project updates.

- `eventId`, version number, status;
- ordered event-phase definitions: `introduction`, `ideation`, `build`, `intermediate_update`, `review_ready`, and `final_update` in the initial version;
- ordered question-purpose definitions: `user`, `problem`, `experience`, `event_goal`, `tradeoff`, `risk`, and `track_fit`;
- supported checkpoint bindings;
- opening, first-answer, freshness-attestation, track-confirmation, brief-review, and terminal prompt keys;
- deterministic fallback keys by phase, purpose, and ordinal;
- generated-question bounds by phase (three to five for `introduction`, one to three for each later phase in the initial version) plus shell-schema version;
- published actor/time and checksum.

The server assigns the event phase from schedule/checkpoint state. Participants do not classify a project's age or build stage. Every project uses the event policy's `fresh_for_event` attestation.

### `intakeQuestionVersions`

- `eventId`, `flowVersionId`;
- stable prompt key and optional event-phase/question-purpose key;
- prompt and optional concise help text;
- input type `information | short_text | long_text | single_choice | multi_choice | confirmation`;
- answer limits and required state;
- brief-field keys the answer may support;
- allowed choice keys when applicable;
- accessible progress label and display metadata;
- deterministic fallback question key;
- status and checksum.

This table stores fixed product text only: **Hello.**, **What is your project about?**, deterministic fallbacks, and required freshness/track/brief confirmations. Model-written follow-ups live in `intakeGeneratedQuestions`, not in this table. Published prompt wording is immutable.

### `intakeRouteRules`

- `eventId`, `flowVersionId`;
- source prompt kind/key;
- ordered structured predicate over checkpoint, server-assigned event phase, confirmed track, purpose coverage, and generated-question count;
- whether to request a generated question and the allowed purpose keys;
- deterministic fallback key by purpose/ordinal;
- next required confirmation or terminal key;
- priority and status.

This is a typed rule set, not executable administrator code. The publisher compiles and simulates it.

### `trackPromptBindings`

- `eventId`, `catalogVersionId`, `trackVersionId`, `flowVersionId`;
- optional event-phase and checkpoint keys;
- optional question-purpose key and generation-guidance text;
- deterministic fallback prompt key and order;
- required/optional state;
- eligibility/disclosure field key;
- status.

Bindings guide a targeted generated question or select a fallback. They cannot force project-specific wording, add rubric criteria, or add model tools.

### `intakeModelConfigVersions`

- `eventId`, version number, status;
- approved OpenAI model ID or snapshot;
- system-instruction, input-redaction, question-policy, Structured Output schema, and evaluation-suite versions/checksums;
- paired flow and track-catalog version IDs;
- phase-specific generated-question bounds, 140-character limit, allowed purpose keys, answer-length enum, blocked-pattern version, and fallback-policy version;
- input/output limits, soft deadline, hard timeout, retry count, and Workpool priority;
- fixed `store: false`, background-off, and no-tools flags;
- published actor/time and checksum.

Published records are immutable. The publish command rejects a model configuration whose evaluation suite has not passed.

### Configuration publication checks

The server refuses publication unless:

- stable keys and display orders are unique;
- the catalog has exactly the configured five core tracks and valid sponsor entries;
- every referenced phase, checkpoint, track, purpose, fixed prompt, brief field, and fallback exists in the paired versions;
- every path begins at the correct phase entry, the introduction asks three to five follow-ups, later phases stay within their smaller bounds, and all paths reach their required confirmations and terminal state;
- every generated-question ordinal/purpose has a deterministic fallback and no required confirmation is unreachable;
- application paths can reach every required submission field for every phase/core-track combination;
- sponsor eligibility/disclosure paths are reachable;
- no track binding changes rubric weights or grants an award;
- model enums and question limits match the paired published catalog/flow;
- the versioned evaluation suite passes relevance, easy-answer, duplicate, compound-question, prohibited-topic/PII, length, source-attribution, and fallback thresholds;
- preview simulations for valid generation, rejected question, timeout, refusal, and invalid output all terminate.

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
- active intake-session ID;
- freshness-attestation state and participant-policy version ID;
- confirmed core-track version ID and sponsor-track version IDs;
- current confirmed project-brief-version ID;
- disclosed general-purpose starting resources and allowed pre-start setup;
- current GitHub/Figma connection IDs;
- `version`, last editor, updated time.

### `intakeSessions`

One team may have an application session and later checkpoint-update sessions.

- `eventId`, `teamId`, `projectDraftId`;
- checkpoint type, server-assigned event-phase key, and optional round ID;
- pinned intake-policy, track-catalog, intake-flow, and intake-model-config version IDs;
- `state: active | review_ready | submitted | superseded | abandoned`;
- current prompt reference, completed prompt references, and generated-question count;
- freshness-attestation state;
- confirmed core-track and sponsor-track version IDs;
- active interpretation ID;
- `version`, last editor, created/updated time.

The session never silently adopts a newly published configuration.

### `intakeAnswerVersions`

Append-only participant-written answers.

- `eventId`, `teamId`, `sessionId`;
- question reference `{ kind: configured | generated, promptKey? | generatedQuestionId? }`;
- answer version number and typed value;
- supersedes answer-version ID when edited;
- written by/time;
- accepted session version and client operation ID;
- status `active | superseded | inactive_for_route`.

The active answer for a prompt reference is resolved through `by_session_question_ref_version`. Changing a track may mark a track-only answer inactive for the current route, but never deletes it.

### `intakeGeneratedQuestions`

Immutable model-written follow-ups and their validation outcome.

- `eventId`, `teamId`, `sessionId`, ordinal;
- question text, `purposeKey`, and `answerLength: short | medium`;
- exact source answer-version IDs;
- event-phase, track-catalog, intake-flow, model-config, instruction, question-policy, and output-schema version IDs;
- `state: active | answered | skipped | replaced | rejected | stale`;
- deterministic validation result and non-sensitive rejection category;
- interpretation ID and created time.

Only one active generated question may occupy a session ordinal. Question text is participant-visible project data and is never copied into job metadata or operational metrics.

### `intakeInterpretations`

Model-produced, non-authoritative drafts.

- `eventId`, `teamId`, `sessionId`;
- exact input answer-version IDs and input checksum;
- track-catalog, intake-flow, model-config, and output-schema version IDs;
- `state: pending | running | succeeded | refused | invalid | timed_out | rate_limited | failed | stale`;
- candidate track keys with source IDs and short reasons;
- source-linked brief-field drafts;
- covered purpose keys;
- proposed `nextQuestion { text, purposeKey, answerLength, sourceAnswerVersionIds }` or `null`, plus `stopReason`;
- provider request ID, model ID, token counts, latency, and non-sensitive failure category;
- created/completed time.

This record cannot become a track selection, participant answer, application decision, route assignment, or score without a separate authorised participant/server command. Raw answer text is not copied into job/error metadata.

### `projectBriefVersions`

Immutable confirmed or generated-draft brief snapshots.

- `eventId`, `teamId`, `sessionId`;
- version number and `state: generated_draft | participant_confirmed | submitted`;
- structured fields `{ key, value, sourceAnswerVersionIds, origin: participant | model_assisted }`;
- server-assigned event-phase key and confirmed track-version IDs;
- intake/track/model-schema version IDs;
- created by/time and confirmed by/time;
- supersedes brief-version ID.

`model_assisted` identifies wording proposed by the model. The participant may edit it; the resulting value still retains its source answer references.

### `projectVersions`

Immutable submission snapshots.

- `eventId`, `teamId`
- project version number;
- active answer-version IDs, confirmed project-brief-version ID, disclosures, and links;
- ordered GitHub binding declarations `{ bindingId, kind, customKind?, purpose, trackedBranch, rootPath? }` and Figma binding ID;
- `fresh_for_event` attestation with participant-policy version, accepted member/time, and official-baseline reference;
- core-track version ID and sponsor-track version IDs;
- intake-policy, track-catalog, intake-flow, intake-model-schema, participant-policy, and integration-policy configuration IDs;
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
- reserved core-track version ID when track capacity is enabled;
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
- domain tags and published track-version keys;
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
- immutable evidence-checkpoint-set ID;
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

### `teamIntegrations`

The ownership boundary for a team’s connected provider resources.

- `eventId`, `teamId`;
- provider `github | figma`;
- `state: setup | active | degraded | content_dirty | stale | reauth_required | inaccessible | revoked | replaced`;
- active binding count and aggregate health/completeness;
- configured resource cap when the provider supports several bindings;
- baseline/current checkpoint-set IDs;
- connection version;
- last provider event, metadata check, successful full sync, and error category/time;
- connected, replaced, or revoked actor/time;
- late-baseline and shared-resource-override flags.

One active integration exists per event/team/provider. Its GitHub integration owns an ordered set of active repository bindings; its Figma integration currently owns one active file binding. A resource-level uniqueness check prevents the same repository or file from being active for two teams in one event unless an administrator records an override.

The GitHub integration is `degraded` when at least one active repository is missing, inaccessible, stale, or incomplete while another remains usable. The team integration does not contain a participant-owned token. Team members read one shared projection, a team lead changes the binding set, and a review session references one frozen evidence checkpoint set.

### `githubInstallations`

One GitHub App installation can serve several team repository bindings.

- `eventId`;
- GitHub installation and account ID;
- account login/type;
- granted repository-selection mode and permission snapshot;
- `state: active | suspended | deleted | permissions_outdated`;
- created, updated, and last webhook time.

Installation access tokens are minted for one job, restricted to that job’s repository and read permissions, and never persisted.

### `githubRepositoryBindings`

- `eventId`, `teamId`, `integrationId`, `installationId`;
- GitHub repository ID, owner/name, URL, visibility, fork/source metadata, and creation time;
- `state: setup | active | inaccessible | revoked | archived | replaced`;
- repository kind `full_product | frontend | backend_api | mobile_app | desktop_app | ai_ml | data_pipeline | hardware_firmware | infrastructure | library_sdk | docs_research | other`;
- custom kind label when kind is `other`, required purpose, and display order;
- default branch, tracked branch, optional root path;
- required topic and `topicState: present | missing | unknown`;
- first/last topic verification time;
- baseline SHA, current head SHA, last push/provider time;
- tree SHA, tree-truncated state, and last reconciliation time;
- current API rate reset/error state;
- connected, classification-changed, archived, and replaced actor/time.

The repository ID, not owner/name, is the durable external key. One integration can contain several active bindings and can reference several installations. Kind is declared by the team rather than inferred from source. Binding replacement preserves the old binding, classification history, and snapshots.

### `figmaAuthorizations`

One encrypted OAuth grant per event/Figma App/Figma user.

- `eventId`;
- Figma `user_id_string`;
- Code2Create person who most recently authorised it;
- exact granted scopes;
- encrypted access token and refresh token;
- token expiry and encryption-key version;
- `state: active | refresh_required | revoked | invalid`;
- authorised, refreshed, revoked, and last-used time.

A team does not own this credential record. A `teamIntegration` owns the selected file and references an authorization that can currently read it. This shape avoids separate token copies and refresh races when one Figma user connects more than one team file.

### `figmaFileBindings`

- `eventId`, `teamId`, `integrationId`, `authorizationId`;
- file key, optional main-file key, name, URL, editor type, link access, and role;
- metadata version, full-content version, provider last-touched time;
- metadata checked, full content captured, and next allowed Tier 1 request time;
- rate-limit plan/type and `Retry-After` state when observed;
- webhook ID, event type, endpoint version, passcode hash, and webhook state;
- latest artifact-manifest key and preview count.

The file key is unique per event unless a shared-resource override is active. Webhook passcodes are compared by hash; the plaintext exists only when the webhook is created or rotated.

### `providerEvents`

- `eventId`, provider, integration ID, and external resource ID;
- provider deduplication key;
- event type;
- GitHub installation/repository/ref/before/after fields or Figma webhook/file/version fields;
- verification result;
- provider time, received time, and processed time;
- processing status and failure category.

GitHub uses `X-GitHub-Delivery`. Figma uses a stable hash of webhook ID, event type, file key, provider timestamp, and version ID when supplied. Raw provider payloads are not retained after validation and field extraction.

### `githubCommitFacts`

One derived row per repository binding/commit SHA seen after baseline.

- `eventId`, `teamId`, `integrationId`, binding ID, repository ID, commit SHA;
- tracked ref and push-delivery reference;
- authored/committed/provider-observed time;
- linked GitHub author/committer IDs and logins when supplied;
- additions, deletions, changed-file count, verification state;
- root-filtered path categories and completeness;
- force-push/discontinuity association.

Do not store commit email, raw message, patch, or source in this table.

### `integrationMetricBuckets`

Materialised provider statistics for fast charts.

- `eventId`, `teamId`, `integrationId`, provider, optional binding ID;
- scope `resource | team_rollup`;
- bucket start and duration;
- metric schema version;
- counter values and bounded top lists;
- source event/snapshot range;
- completeness and computed time.

Hourly GitHub resource buckets contain pushes, commits, additions, deletions, changed files, linked/unknown authors, and force pushes for one repository. Team rollups include repository/kind counts, topic coverage, the union of linked users, combined counters, overlap count, and complete/expected repository counts. Duplicate commit SHAs across connected forks count once in a combined total and remain visible in each resource bucket. Figma buckets contain observed metadata changes, full snapshots, changed top-level frames, named versions, and comment-state changes. Current totals are updated in the same mutation as the accepted derived facts; dashboards never scan every provider event to draw a card.

### `integrationSnapshots`

- `eventId`, `teamId`, provider, integration ID, provider-binding ID;
- resource kind and display label at capture time;
- checkpoint type `baseline | provider_refresh | review_window | review_start | round_close | manual_refresh`;
- round/review references;
- provider resource version;
- captured time and provider source time;
- metric schema version and sanitised summary;
- private S3 artifact-manifest key, object checksum, and preview count when present;
- freshness, completeness, truncation, and error state;
- previous snapshot ID.

Each GitHub snapshot belongs to one repository binding and contains its declared kind/purpose, topic state, tracked/baseline/head SHAs, tree manifest, activity totals, changed-path summary, languages, discontinuities, and completeness. Figma snapshots contain file/version metadata, node and reuse statistics, named versions, comment counts, top-level-node hashes, changed-frame summary, and protected preview/artifact references.

### `evidenceCheckpointSets`

One immutable team evidence bundle used by a review or round transition.

- `eventId`, `teamId`;
- checkpoint type `baseline | review_window | review_start | round_close | manual_refresh`;
- ordered GitHub entries `{ bindingId, repositoryId, kind, purpose, snapshotId?, stateAtCapture }`;
- optional Figma entry `{ bindingId, snapshotId?, stateAtCapture }`;
- expected and captured resource counts;
- aggregate freshness/completeness and missing-resource reasons;
- round/review references;
- previous checkpoint-set ID;
- created actor/time and manifest checksum.

Every active repository appears even when its snapshot failed, so a missing backend repository cannot disappear from reviewer context. A review session stores this set’s ID. Later repository additions, removals, reordering, kind changes, or provider refreshes create another set and never mutate the first.

### `figmaNodeFacts`

One bounded row per page or selected top-level node in a Figma snapshot.

- `eventId`, `teamId`, `integrationId`, `snapshotId`;
- Figma node ID, parent page ID, type, name, and visible state;
- semantic hash and optional render hash;
- descendant/component/instance/reaction counts;
- preview object key, dimensions, and render state;
- change state versus previous snapshot.

The raw node tree remains in compressed private object storage. These rows drive the page/frame browser and changed-screen list without loading the entire document into a Convex query.

### `externalJobs`

- `eventId`
- kind `intake_interpret | github_enrich | github_reconcile | figma_metadata | figma_content | figma_render | figma_webhook_repair | push_send | push_receipt | artifact_upload | export_upload`;
- deduplication key;
- target reference;
- Workpool name/work ID and priority;
- `state: pending | running | provider_wait | retry | succeeded | failed | cancelled`;
- attempt count, next attempt/provider reset, last status/error category;
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
| `trackCatalogVersions.by_event_status_version` | Resolve or publish a catalog |
| `trackVersions.by_catalog_type_status_order` | Show the exact core/sponsor track set |
| `intakeFlowVersions.by_event_status_version` | Resolve a published intake shell |
| `intakeQuestionVersions.by_flow_key` | Load one immutable prompt |
| `intakeRouteRules.by_flow_source_priority` | Resolve the next eligible prompt without scans |
| `trackPromptBindings.by_catalog_flow_track_phase` | Apply track/phase guidance |
| `intakeModelConfigVersions.by_event_status_version` | Resolve the approved model contract |
| `teamMembers.by_event_membership_status` | Prevent two active teams |
| `intakeSessions.by_team_checkpoint_state` | Resume one team/checkpoint flow |
| `intakeAnswerVersions.by_session_question_ref_version` | Resolve answer history and active text |
| `intakeGeneratedQuestions.by_session_ordinal` | Enforce and resume one immutable generated follow-up per ordinal |
| `intakeInterpretations.by_session_input_checksum` | Deduplicate and reject stale model work |
| `projectBriefVersions.by_team_version` | Load exact source-linked brief history |
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
| `teamIntegrations.by_event_team_provider` | One shared provider binding per team |
| `teamIntegrations.by_event_provider_state` | Operations health board |
| `githubInstallations.by_event_installation` | Resolve an App webhook installation |
| `githubRepositoryBindings.by_event_repository_state` | Route a repository event and prevent duplicate use |
| `githubRepositoryBindings.by_integration_state_order` | Ordered active repository set for one team |
| `figmaAuthorizations.by_event_figma_user` | One refreshable Figma grant per provider user |
| `figmaFileBindings.by_event_file_state` | Route a webhook and prevent duplicate use |
| `providerEvents.by_provider_dedupe` | Ignore retries/replays |
| `githubCommitFacts.by_binding_sha` | Idempotent per-repository commit enrichment |
| `integrationMetricBuckets.by_integration_scope_binding_bucket` | Per-resource and team-rollup charts without scans |
| `integrationSnapshots.by_binding_time` | Compare one resource across checkpoints |
| `evidenceCheckpointSets.by_team_time` | Load immutable multi-resource review evidence |
| `figmaNodeFacts.by_snapshot_page_node` | Captured Figma page/frame browser |
| `externalJobs.by_state_next_attempt` | Workpool/provider retry diagnostics |
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

### `participant.intake`

Returns the current fixed or generated prompt, accepted answer/save/skip state, subtle phase/checkpoint progress, freshness-attestation state, confirmed tracks, brief-review state, and the next allowed participant action for the caller's team. Generated question text appears only when its source, ordinal, session, and configuration versions are current. It never returns the OpenAI request ID, system instruction, another team's text, model diagnostics, or an unconfirmed suggestion as selected state.

### `participant.integrationEvidence`

Returns the caller's team-owned GitHub repository set and Figma binding, repository kinds/purposes, topic/webhook state, per-resource and team-rollup metrics, latest checkpoint-set summary, changed-frame/path lists, and freshness fields. Repositories are ordered by the team’s display order. It never returns an OAuth grant, installation token, S3 object key, or another team's provider resource.

### `admissions.reviewQueue`

Returns only the current application reviewer’s assigned application versions and own submitted recommendations.

### `admissions.capacity`

Returns application/review coverage, decisions, active offer reservations, confirmed participant counts, and remaining capacity. Detailed personal data requires a narrower query.

### `reviewer.now`

Returns clock-in state, active panel seat, current page, active session summary, save state, and next action. It returns one reviewer’s work only.

### `reviewer.activeContext`

Returns the fixed project/rubric/evidence-checkpoint-set context for the assigned active session and that reviewer’s scorecard.

### `reviewer.integrationEvidence`

Accepts only the checkpoint-set ID attached to the caller's assigned current/recent review. A GitHub request must also name a repository entry in that set. It returns the ordered repository index, the selected repository’s pinned tree and file-view capability, or Figma page/frame facts and short-lived preview access. A newer live team checkpoint set may be advertised, but it does not replace the scoring context.

### `operations.roundBoard`

Returns round state, panel summaries, team-state counts, critical exceptions, and stale timestamps. Detail opens through separate indexed queries.

### `operations.integrationHealth`

Returns one compact row per team/provider with active-resource count, aggregate state, topic/webhook coverage, provider/metadata/content ages, current job state, rate-limit wait, completeness, and next action. GitHub detail returns one child row per repository with kind, branch/root, topic, freshness, and job state. Detail queries expose event facts and metric buckets without returning credentials or raw artifacts.

### `operations.intakeConfiguration`

Returns draft/published catalog, event-phase, intake-shell, question-policy, guidance, fallback, and model-config summaries; publish validation/evaluation results; simulated paths; active-session counts by pinned version; and safe rollback targets. Editing and publication require event-configuration capability.

### `operations.intakeHealth`

Returns answer-save and interpretation latency, Workpool depth/age, success/refusal/invalid/question-policy-rejection/timeout/rate-limit/fallback counts, skips by purpose/fallback key, aggregate question-length/quality evaluation metrics, and affected configuration versions. It excludes answer text, generated-question text, generated brief text, contact data, and provider payloads.

### `operations.scoreCompleteness`

Returns required/submitted scorecard and criterion counts plus flags. Score values and `evaluationResults` require another capability and query.

Subscriptions update only when records read by the query change. Screens use stable IDs and preserve local focus while data refreshes.

## 14. Command surface

| Area | Main commands |
| --- | --- |
| Identity | create auth intent, provision participant, claim roster, revoke grant, register/revoke device |
| Team/project | create/join/leave team, transfer lead, start/resume intake, save answer, skip generated question, accept fresh-project attestation, confirm tracks, confirm brief, submit version, start/confirm team integration, add/classify/reorder/archive/replace repository |
| Intake configuration | draft/clone/validate/simulate/publish/retire track catalog, intake flow, prompt binding, and model config |
| Admissions | assign application, submit own recommendation, request information, publish decision, send/respond/expire offer, promote waitlist |
| Venue | check in participant, assign/freeze table, report mismatch |
| Round/panel | publish plan, clock in, mark unavailable, page substitute, accept/decline page |
| Queue/review | set ready, route, call, hold, move, scan presence, start, extend, complete |
| Score | save own draft, submit own scorecard, request/approve correction, resubmit, void |
| Operations | pause/resume round, resolve support case, approve manual mode, import/verify paper record, close/reopen round |
| Integration | verify/deduplicate provider event, refresh metadata/content, reconcile, render, retry/pause/disable binding |
| Synesthesia | request, vote, moderate, acknowledge playback |

Each command has one server implementation used by web and mobile. A mobile-specific API does not apply different judging rules.

## 15. Concurrency cases

### Two team joins

Both mutations query active membership by event/person. One commits; the other retries and returns “already in a team.”

### Two answer saves

Both carry the expected intake-session version. One commits a new immutable answer version. The other retries against the changed session and returns the current prompt/answer instead of replacing it.

### Answer versus skip

Both carry the expected session version and generated-question ID. The first accepted command changes the question from `active` to `answered` or `skipped` and advances the session. The loser returns the accepted state; it cannot create a second answer or advance another ordinal.

### Late model interpretation

The completion mutation compares session, active answer IDs, input checksum, and paired configuration versions. If any changed, it marks the interpretation stale. It cannot alter the current question or confirmed fields.

### Track change during interpretation

Confirming a different core track increments the session version, recomputes phase guidance/fallback bindings, and marks obsolete track-only answers inactive. Pending output for the prior track becomes stale; raw answers and displayed generated questions remain.

### Config publication during an active session

Publication changes only the event defaults for new sessions. Existing sessions keep pinned IDs. A migration is a separate previewed command with explicit key mappings and affected-session counts.

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
- intake answer versions, generated questions, model interpretations, confirmed briefs, and submitted project versions;
- provider credentials;
- integration bindings, checkpoint sets, facts, snapshots, raw Figma artifacts, comments, previews, and short-lived GitHub blob cache;
- reviewer private notes;
- submitted scorecards and audit events;
- support/incident records;
- Synesthesia requests/votes;
- exports/backups.

Provider credentials should be deleted soon after the last dependent team checkpoint and complaint window. Disconnecting one team removes its authorization reference and webhook; it does not revoke a shared Figma grant still used by another team. Revoking the provider grant marks every dependent binding for reauthorization. Historical snapshot manifests remain until their evidence-retention date, while GitHub blob cache expires after the review window.

The event privacy notice separately states that project text is sent to OpenAI for interpretation. Requests use `store: false`; the event must not claim this means zero retention because ordinary API abuse-monitoring logs may retain content for up to 30 days unless approved OpenAI data controls apply. Internal interpretations and generated questions follow the approved project-record period and can be deleted without deleting participant-written answers or submitted brief versions.

Operational judging records use status/versions rather than hard deletion during the event and complaint window.

## 17. Schema acceptance

- Cross-event IDs fail authorization even when the caller has the same role in another event.
- A published catalog contains the configured five core tracks, and every submitted project names exactly one published core-track version.
- Sponsor entries are optional, versioned, eligibility-checked, and cannot replace the core track or change rubric weights.
- Every project is recorded as `fresh_for_event`; there is no continuation classification or participant-selected build stage.
- Every introduction asks three to five follow-ups; later phase/track combinations respect their published smaller bounds and terminate through valid generated questions or deterministic no-model fallbacks.
- A model result with unknown IDs, stale answers, invalid schema, a repeated/compound/overlong/prohibited question, refusal, or late completion changes no authoritative project field or visible prompt.
- Every model-assisted brief field links to participant-written answer versions.
- Editing an answer, changing a track, or publishing configuration cannot erase answer history or rewrite a submitted project version.
- A participant cannot hold two active team memberships.
- One application reviewer cannot submit two active recommendations for the same application.
- Active offered/confirmed admission records cannot reserve more participants than approved capacity.
- One team and one panel cannot enter two active review sessions.
- One reviewer cannot occupy overlapping active seats.
- One reviewer/session produces one scorecard with immutable submitted versions.
- Every complete evaluation result names the exact immutable scorecard versions used.
- Round close cannot race past a required scorecard.
- Live participant, reviewer, and operations views derive from the same operational records.
- A provider resource cannot be active for two teams in one event without an audited override.
- One team can hold several active GitHub repository bindings, including bindings from different App installations.
- Every active repository has a kind, purpose, branch/root, baseline, independent status, metrics, and snapshots.
- Replacing the member who authorised Figma does not change the team that owns the file evidence.
- Duplicate GitHub/Figma provider events cannot increment a fact or metric twice.
- A review session keeps its original evidence-checkpoint-set ID when repository membership, classification, order, or snapshots change.
- Combined GitHub metrics identify incomplete repositories and duplicate commit overlap instead of silently double-counting or omitting them.
- Provider credentials never appear in project, snapshot, job, query, audit, or error payloads.
- A backup/restore and round export preserve every relation needed to reproduce totals and exception history.

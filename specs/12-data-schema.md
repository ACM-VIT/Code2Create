# Data schema

## 1. Schema goals

The Convex schema must make invalid event states difficult to create, efficient live projections easy to query, and every consequential transition explainable later.

It is optimized for:

- one authoritative current state;
- reactive task-oriented reads;
- transactionally enforced invariants;
- append-only outcome history;
- idempotent client commands;
- scoped authorization;
- explicit configuration revisions;
- venue-scale burst traffic;
- safe schema evolution while older reviewer builds may still be installed.

This is a Convex document model, not a SQL schema copied into documents. Closely owned, low-churn values may be nested. Records that need independent lifecycle, indexing, authorization, or realtime invalidation receive their own table.

## 2. Global conventions

Convex supplies `_id` and `_creationTime`.

Mutable canonical records add:

| Field | Meaning |
| --- | --- |
| `eventId` | Event boundary for authorization and indexes |
| `status` | Explicit string-literal state |
| `version` | Integer incremented on every accepted domain change |
| `updatedAt` | Server timestamp of last accepted domain change |
| `updatedBy` | Internal user ID or system actor |
| `configRevisionId` | Frozen policy/configuration revision where semantics depend on it |

Additional conventions:

- IDs use Convex `Id<"table">`, never external strings.
- External identifiers are isolated in identity/integration records.
- All time is UTC epoch milliseconds. Venue display converts to `Asia/Kolkata`.
- Enum values are lowercase snake case and validated with `v.union(v.literal(...))`.
- Optional and nullable are distinct. `undefined` means absent/not collected; `null` means explicitly none where the API needs that distinction.
- Human-readable codes such as table `A-17` are not primary keys.
- Names/emails copied into immutable exports are snapshots, clearly named `...Snapshot`.
- No table relies on an index being unique; mutations enforce uniqueness transactionally.
- Soft lifecycle states are preferred to destructive deletion during the retention window.

## 3. Identity and access

### `users`

One internal human identity.

Core fields:

- `clerkSubject`
- `status`: `active | suspended | merged | deleted`
- `primaryEmail`
- `primaryEmailVerified`
- `displayName`
- `avatarUrl?`
- `mergedIntoUserId?`
- `lastAuthenticatedAt`
- `version`, `updatedAt`

Indexes:

- `by_clerk_subject [clerkSubject]`
- `by_primary_email [primaryEmail]` for administrative duplicate review only
- `by_status [status]`

### `identityLinks`

Stable upstream identities linked to a user.

Core fields:

- `userId`
- `provider`: initially `google`
- `providerSubject`: Google `sub`
- `clerkExternalAccountId?`
- `emailAtVerification`
- `hostedDomain?`
- `verifiedAt`
- `lastVerifiedAt`
- `verificationMethod`: `google_oidc | google_workspace_sso | admin_migration`
- `revokedAt?`

Indexes:

- `by_provider_subject [provider, providerSubject]`
- `by_user_provider [userId, provider]`

### `authIntents`

Pre-auth participant classification bound to one callback.

Core fields:

- `nonceHash`
- `requestedAccountClass`: `vit_student | external`
- `safeReturnPath`
- `browserBindingHash`
- `createdAt`
- `expiresAt`
- `consumedAt?`
- `consumedByUserId?`
- `failureCode?`

Indexes:

- `by_nonce_hash [nonceHash]`
- `by_expiry [expiresAt]`

Raw nonces are never stored.

### `eventMemberships`

User participation in one event.

Core fields:

- `eventId`, `userId`
- `accountClass`: `vit_student | external | staff_only`
- `status`: `onboarding | active | ineligible | withdrawn | suspended`
- `identityPolicyRevisionId`
- `profileComplete`
- `termsVersion`, `termsAcceptedAt`
- `eligibilityReasonCode?`
- `version`, `updatedAt`

Indexes:

- `by_event_user [eventId, userId]`
- `by_event_class_status [eventId, accountClass, status]`

Only one active membership per event/user is allowed.

### `participantProfiles`

Event-specific participant data, separate from global login identity.

Core fields:

- `eventId`, `userId`
- `registrationNumber?`
- `campus?`, `programme?`, `graduationYear?`
- `institution?`, `affiliation?`, `city?`, `countryCode?`
- `phoneEncrypted?`, `contactPreference?`
- `accessibilityLogistics?` with restricted visibility
- `completionFields`
- `version`, `updatedAt`

Indexes:

- `by_event_user [eventId, userId]`
- `by_event_registration [eventId, registrationNumber]`

### `rosterInvitations`

Approved reviewer/staff/board/auditor identities awaiting claim.

Core fields:

- `eventId`
- `inviteType`
- `normalizedEmail`
- `expectedGoogleSubject?`
- `roleTemplateId`
- `scope`
- `status`: `draft | sent | claimed | revoked | expired`
- `tokenHash?`, `expiresAt?`
- `claimedByUserId?`, `claimedAt?`
- `createdBy`, `version`

Indexes:

- `by_event_email [eventId, normalizedEmail]`
- `by_token_hash [tokenHash]`
- `by_event_status [eventId, status]`

### `roleGrants`

Application capability grant.

Core fields:

- `eventId`, `userId`
- `roleTemplate`: `participant | reviewer | panel_lead | ops | review_admin | board_admin | moderator | auditor`
- `capabilities`
- `scopeType`: `event | round | panel | team | criterion | venue_zone`
- `scopeId?`
- `source`: roster/invitation/grant ID
- `startsAt`, `endsAt?`
- `status`: `active | suspended | expired | revoked`
- `grantedBy`, `revokedBy?`, `reason?`
- `version`

Indexes:

- `by_event_user_status [eventId, userId, status]`
- `by_event_role_status [eventId, roleTemplate, status]`
- `by_scope [eventId, scopeType, scopeId, status]`

### `devices`

Core fields:

- `eventId`, `userId`
- `installationId`
- `platform`, `model?`, `osVersion?`
- `appVersion`, `runtimeVersion`
- `notificationPermission`
- `status`: `active | revoked | replaced`
- `lastSeenAt`, `lastSyncAt?`
- `revokedAt?`, `revocationReason?`

Indexes:

- `by_installation [installationId]`
- `by_event_user_status [eventId, userId, status]`
- `by_event_last_seen [eventId, lastSeenAt]`

### `pushTokens`

Core fields:

- `eventId`, `userId`, `deviceId`
- `provider`: `expo | fcm | apns`
- `tokenHash`
- `tokenEncrypted`
- `environment`: `development | staging | production`
- `status`: `active | disabled | invalid`
- `lastRegisteredAt`, `lastSuccessAt?`, `lastFailureCode?`

Indexes:

- `by_device_provider [deviceId, provider]`
- `by_event_user_status [eventId, userId, status]`
- `by_token_hash [tokenHash]`

## 4. Event and policy configuration

### `events`

- `slug`, `name`, `edition`
- `timezone`
- `status`: `draft | registration_open | registration_closed | live | completed | archived`
- `activeConfigRevisionId?`
- `registrationOpensAt?`, `registrationClosesAt?`
- `startsAt?`, `endsAt?`
- `version`

Indexes: `by_slug`, `by_status`.

### `eventConfigs`

Immutable once published.

- `eventId`, `revisionNumber`
- `status`: `draft | published | superseded`
- `identityPolicy` including VIT hosted-domain allowlist
- `teamPolicy`
- `queuePolicy`
- `reviewPolicy`
- `retentionPolicy`
- `supportedClientPolicy`
- `synesthesiaPolicy`
- `changeSummary`, `publishedAt?`, `publishedBy?`

Indexes:

- `by_event_revision [eventId, revisionNumber]`
- `by_event_status [eventId, status]`

### `tracks`

- `eventId`, `configRevisionId`
- `code`, `name`, `description`
- `kind`: `primary | sponsor | open`
- `capacity?`, `status`, `sortOrder`

Index: `by_event_status_order [eventId, status, sortOrder]`.

### `rounds`

- `eventId`, `configRevisionId`
- `code`, `name`, `sequence`
- `kind`: `review | elimination | final`
- `status`: `draft | staffing | ready | open | paused | closing | closed | reopened`
- `rubricVersionId`, `timingPolicy`, `queuePolicy`
- `scheduledStartAt?`, `scheduledEndAt?`
- `openedAt?`, `closedAt?`
- `version`

Indexes:

- `by_event_sequence [eventId, sequence]`
- `by_event_status [eventId, status]`

### `rubricVersions`

- `eventId`, `revisionNumber`, `name`
- `status`: `draft | published | retired`
- `scaleMin`, `scaleMax`
- `aggregationPolicy`
- `publishedAt?`, `publishedBy?`

Index: `by_event_revision`.

### `criteria`

Stable concept such as originality or technical execution.

- `eventId`, `code`, `name`
- `description`, `evidenceGuidance`
- `status`

Index: `by_event_code`.

### `rubricCriteria`

Version-specific criterion definition.

- `eventId`, `rubricVersionId`, `criterionId`
- `label`, `definition`, `anchors`
- `weight`, `sortOrder`
- `required`, `rationalePolicy`

Indexes:

- `by_rubric_order [rubricVersionId, sortOrder]`
- `by_rubric_criterion [rubricVersionId, criterionId]`

### `venues`, `venueZones`, `venueTables`

Venue hierarchy and human-readable table codes.

Important table fields:

- event and parent IDs;
- code/name;
- capacity;
- accessibility/logistics tags;
- status: `active | unavailable | retired`;
- version.

Indexes support event, parent, code, and status queries.

## 5. Teams, projects, and venue participation

### `teams`

- `eventId`
- `publicCode`, `name`
- `leadUserId`
- `status`: `forming | eligible | submitted | shortlisted | checked_in | active | withdrawn | disqualified | completed`
- `activeProjectVersionId?`
- `currentTableAssignmentId?`
- `version`, `updatedAt`

Indexes:

- `by_event_public_code [eventId, publicCode]`
- `by_event_status [eventId, status]`
- `by_lead [eventId, leadUserId]`

### `teamMembers`

- `eventId`, `teamId`, `userId`
- `role`: `lead | member`
- `status`: `invited | active | removed | declined`
- `joinedAt?`, `endedAt?`
- `membershipRevision`, `version`

Indexes:

- `by_event_user_status [eventId, userId, status]`
- `by_team_status [teamId, status]`

The create/join mutation ensures one active team per participant and valid team size.

### `teamInvitations`

- `eventId`, `teamId`
- `tokenHash`
- `invitedEmail?`
- `status`, `expiresAt`, `acceptedBy?`
- `createdBy`

Indexes: `by_token_hash`, `by_team_status`.

### `projectProfiles`

Current project identity.

- `eventId`, `teamId`
- `title`, `oneLineSummary`, `trackId`
- `activeVersionId`
- `status`: `draft | submitted | revision_requested | locked`
- `version`

Indexes: `by_team`, `by_event_track_status`.

### `projectVersions`

Immutable submitted or saved narrative snapshot.

- `eventId`, `teamId`, `projectProfileId`
- `revisionNumber`
- canonical structured answers
- disclosures: tools, APIs, models, datasets, templates, prior work
- repository/demo/evidence links
- safety/privacy responses
- round commitments
- `state`: `draft_snapshot | submitted | superseded`
- `createdBy`, `submittedAt?`
- `contentHash`

Indexes:

- `by_project_revision [projectProfileId, revisionNumber]`
- `by_team_state [teamId, state]`

### `eligibilityDecisions`

- `eventId`, `teamId`
- `kind`: `registration | shortlist | disqualification | reinstatement`
- `decision`: `pending | eligible | ineligible | waitlisted | selected | rejected`
- `reasonCode`, `reasonDetail?`
- `projectVersionId`
- `decidedBy`, `decidedAt`
- `replacesDecisionId?`

Indexes: `by_team_kind`, `by_event_kind_decision`.

### `checkins`

- `eventId`, `userId`, `teamId?`
- `kind`: `participant | team | reviewer | staff`
- `status`: `present | left | corrected`
- `method`, `stationId?`
- `recordedBy`, `recordedAt`
- `replacesCheckinId?`

Indexes: `by_event_user_time`, `by_team_time`.

### `tableAssignments`

- `eventId`, `teamId`, `tableId`
- `roundId?`
- `status`: `planned | active | ended | disputed`
- `startsAt`, `endsAt?`
- `confirmedAt?`, `confirmedBy?`
- `reasonCode`
- `version`

Indexes:

- `by_team_status [eventId, teamId, status]`
- `by_table_status [eventId, tableId, status]`
- `by_round_status [roundId, status]`

Mutations ensure no overlapping active assignment for a team or table.

## 6. Reviewers, panels, and routing

### `reviewerProfiles`

- `eventId`, `userId`
- `organisationRole`
- `trainingStatus`
- `deviceReadiness`
- `status`: `invited | active | paused | suspended`
- `maxConcurrentLoad`, `notesRestricted?`
- `version`

Index: `by_event_user`, `by_event_status`.

### `expertiseTags`

- `eventId`, `code`, `label`, `category`, `status`

Index: `by_event_code`.

### `reviewerExpertise`

- `eventId`, `reviewerUserId`, `expertiseTagId`
- `level`, `verificationSource`
- `verifiedBy`, `verifiedAt`
- `status`

Indexes: `by_reviewer_status`, `by_tag_status`.

### `criterionGrants`

- `eventId`, `reviewerUserId`, `criterionId`
- `roundId?`
- `status`
- `qualificationSource`
- `grantedBy`, `grantedAt`

Indexes: `by_reviewer_round_status`, `by_round_criterion_status`.

### `reviewerAvailability`

- `eventId`, `reviewerUserId`, `roundId`
- `status`: `available | unavailable | tentative | clocked_in | paused | left`
- `startsAt?`, `endsAt?`, `locationZoneId?`
- `version`

Indexes: `by_round_status`, `by_reviewer_round`.

### `conflicts`

- `eventId`, `reviewerUserId`
- `teamId?`, `userId?`, `projectProfileId?`
- `kind`, `severity`
- `status`: `declared | confirmed | cleared | overridden`
- `privateReasonEncrypted?`
- `declaredBy`, `reviewedBy?`
- `version`

Indexes:

- `by_reviewer_team_status [eventId, reviewerUserId, teamId, status]`
- `by_team_status [eventId, teamId, status]`

### `panels`

- `eventId`, `roundId`
- `code`, `leadUserId?`
- `status`: `draft | published | assembling | ready | busy | paused | closed`
- `homeZoneId?`
- `requiredMemberCount`
- `coverageSummary`
- `version`

Indexes: `by_round_status`, `by_round_code`.

### `panelMembers`

- `eventId`, `roundId`, `panelId`, `reviewerUserId`
- `role`: `lead | scorer | observer`
- `status`: `planned | notified | acknowledged | clocked_in | present | substituted | removed`
- `startsAt`, `endsAt?`
- `criterionIds`
- `replacesPanelMemberId?`
- `version`

Indexes:

- `by_panel_status [panelId, status]`
- `by_reviewer_round_status [reviewerUserId, roundId, status]`

### `teamPanelAssignments`

- `eventId`, `roundId`, `teamId`, `panelId`
- `status`: `recommended | approved | active | completed | cancelled | superseded`
- `fitReasons`, `warnings`
- `assignmentRevision`
- `approvedBy?`, `version`

Indexes:

- `by_round_team_status [roundId, teamId, status]`
- `by_panel_status [panelId, status]`

### `pages` and `substitutionAttempts`

`pages` is one alert to one target reviewer. `substitutionAttempts` groups the candidates and outcome for a missing panel slot.

Indexes cover target/status/deadline, panel/status, and substitution/status. Accepting a page updates page, attempt, and panel membership atomically.

## 7. Queue and review execution

### `queueEntries`

- `eventId`, `roundId`, `teamId`, `panelId`
- `status`: `draft | ready | queued | called | accepted | hold | missed | in_review | submitted | complete | withdrawn | cancelled`
- `orderingKey`
- `priorityClass`, `priorityReason?`
- `readyAt?`, `calledAt?`, `startedAt?`, `completedAt?`
- `estimatedWindowStart?`, `estimatedWindowEnd?`
- `holdCode?`, `holdDetail?`
- `assignmentRevision`
- `version`

Indexes:

- `by_round_team [roundId, teamId]`
- `by_panel_status_order [panelId, status, orderingKey]`
- `by_round_status_order [roundId, status, orderingKey]`
- `by_round_updated [roundId, updatedAt]`

### `reviewSessions`

- `eventId`, `roundId`, `teamId`, `panelId`, `queueEntryId`
- `status`: `pending_presence | ready | active | paused | submitting | completed | voided`
- `rubricVersionId`, `projectVersionId`, `configRevisionId`
- `leaseEpoch`
- `leaseHolderPanelId?`, `leaseAcquiredAt?`, `leaseExpiresAt?`
- `startedAt?`, `pausedAt?`, `completedAt?`
- `timerBudgetSeconds`, `totalExtensionSeconds`
- `version`

Indexes:

- `by_round_team [roundId, teamId]`
- `by_panel_status [panelId, status]`
- `by_status_lease_expiry [status, leaseExpiresAt]`

### `reviewPresence`

- `eventId`, `reviewSessionId`, `reviewerUserId`, `panelMemberId`
- `status`: `required | verified | excused | invalidated`
- `method`: `team_qr | staff_fallback | override`
- `qrNonceHash?`
- `verifiedAt?`, `verifiedBy?`
- `leaseEpoch`
- `version`

Index: `by_session_reviewer`, `by_session_status`.

### `timerEvents`

Append-only:

- `reviewSessionId`
- `type`: `started | paused | resumed | threshold | stopped | corrected`
- `serverAt`
- `actorUserId`
- `leaseEpoch`
- `reason?`
- `replacesEventId?`

Index: `by_session_time`.

### `extensions`

- `reviewSessionId`
- `durationSeconds`
- `kind`: `ordinary | admin | incident`
- `status`: `requested | granted | rejected | revoked`
- `requestedBy`, `decidedBy?`, `reason`
- `policyRevision`

Index: `by_session_status`.

### `evidenceRecords`

- `eventId`, `roundId`, `reviewSessionId`, `teamId`
- `authorReviewerUserId`
- `type`
- `observation`
- `verificationState`: `observed | claimed | not_verified | contradicted`
- `sourceUrl?`, `fileId?`
- `visibility`: `private_reviewer | review_admin | participant_feedback`
- `version`, `supersedesEvidenceId?`

Indexes: `by_session_author`, `by_team_round`.

### `scores`

Each document is one submitted immutable version for one reviewer/criterion/session.

- `eventId`, `roundId`, `reviewSessionId`, `teamId`
- `reviewerUserId`, `criterionId`, `rubricCriterionId`
- `score`
- `rationale?`
- `submissionGroupId`
- `versionNumber`
- `status`: `submitted | corrected | voided`
- `supersedesScoreId?`
- `submittedAt`
- `commandReceiptId`

Indexes:

- `by_session_reviewer_criterion [reviewSessionId, reviewerUserId, criterionId]`
- `by_team_round_criterion [teamId, roundId, criterionId]`
- `by_submission_group [submissionGroupId]`

The active score is the latest valid version selected through the correction chain. A correction never overwrites the original.

### `reviewNotes`

- session/team/round and author IDs
- `category`
- encrypted or plain content according to visibility
- `visibility`
- `status`, `version`, `supersedesNoteId?`

Indexes: `by_session_visibility`, `by_team_round`.

### `commitments` and `commitmentAssessments`

Commitments capture what a team agrees to deliver by the next round. Assessments link later reviewer evidence to `met | partial | not_met | changed_with_reason`.

Indexes support team/round and source commitment.

### `advancementDecisions`

- `eventId`, `roundId`, `teamId`
- `kind`: `advance | eliminate | finalist | award | disqualify | reinstate`
- `status`: `draft | approved | published | superseded`
- `policyRevisionId`
- `aggregateSnapshot`
- `reasonCode`, `reasonDetail?`
- `decidedBy`, `approvedBy?`
- `supersedesDecisionId?`

Indexes: `by_round_status_kind`, `by_team_round`.

### `processCases`

Participant or staff process issue/appeal, evidence, owner, status, and disposition. It is not a score-edit request.

## 8. Commands, events, audit, and operations

### `commandReceipts`

- `eventId`
- `actorUserId`
- `deviceId?`
- `clientMutationId`
- `commandName`
- `targetType`, `targetId?`
- `requestHash`
- `status`: `accepted | rejected_after_commit?`
- `result`
- `createdAt`
- `expiresAt?`

Indexes:

- `by_actor_client_mutation [actorUserId, clientMutationId]`
- `by_event_command_time [eventId, commandName, createdAt]`

The uniqueness check is `(actorUserId, clientMutationId)`. Reuse with a different request hash is a security/conflict error.

### `domainEvents`

Append-only business facts:

- `eventId`
- `sequenceBucket`, `occurredAt`
- `type`
- aggregate type/ID and version
- actor and command receipt
- public-safe structured payload
- related round/team/panel/session IDs

Indexes: by aggregate/version, event/time, event/type/time.

### `auditEvents`

Append-only restricted history:

- all domain-event correlation fields;
- evaluated capability/grant IDs;
- before/after hashes or redacted diff;
- reason;
- device/request/connectivity metadata;
- sensitivity and retention class.

Indexes: actor/time, target/time, round/time, action/time.

### `overrides`

- event/round/team/panel/session scope
- blocked rule
- capability required
- status: `requested | active | expired | revoked | completed`
- reason and attempted alternatives
- grantedBy, startsAt, expiresAt?
- downstream flags

Indexes: event/status, target/status, expiry.

### `notificationJobs`

- `eventId`
- `dedupeKey`
- `type`, `audience`
- template and safe payload
- priority
- `notBefore`, `expiresAt`
- `status`: `pending | processing | sent | partial | retry | failed | cancelled`
- `attemptCount`, `nextAttemptAt?`
- source domain event/command receipt

Indexes: `by_status_next_attempt`, `by_dedupe_key`, `by_event_type_time`.

### `notificationDeliveries`

One attempt/recipient/device:

- job/user/device/token IDs
- provider
- attempt
- ticket ID?
- receipt status/error
- sent/received/acknowledged timestamps

Indexes: job/status, ticket ID, user/time.

### `incidents`

- event and affected scope
- severity
- status
- commander/owners
- summary, current impact, runbook
- opened/resolved timestamps
- activated degraded-mode policy?
- version

Indexes: event/status/severity, opened time.

### `exportJobs`

Requested snapshot/export, filters, policy revision, status, checksum, storage reference, requester, expiry, and download audit.

### `opsProjections`

Optional transactionally maintained documents for measured high-cost command-centre aggregates. Every field declares its canonical source and last source version. A projection can be rebuilt and never becomes a write target for domain commands.

## 9. Synesthesia

### `songRequests`

- `eventId`, canonical catalogue/source ID
- title/artist/duration metadata
- requester
- moderation and playback status
- active vote count
- eligibility window
- version

Indexes: source ID, status/vote/order, requester/time.

### `songVotes`

- `eventId`, `songRequestId`, `userId`
- `status`: `active | removed`
- version/timestamps

Indexes:

- `by_request_user [songRequestId, userId]`
- `by_request_status [songRequestId, status]`

### `playbackItems`

Canonical moderated queue/history item with ordering key, playback lease epoch, scheduled window, status, and timestamps.

### `playbackEvents` and `moderationActions`

Append-only control and moderation history.

Synesthesia tables and functions use separate query shapes and scheduled jobs so popularity traffic does not invalidate core review projections.

## 10. Critical state transitions

### Queue

```text
draft → ready → queued → called → accepted → in_review → submitted → complete
           ↘ withdrawn
queued/called → hold → queued
called → missed → hold/requeued
pre-review → cancelled
```

### Review session

```text
pending_presence → ready → active ↔ paused → submitting → completed
                                      ↘ voided (privileged disposition)
```

### Round

```text
draft → staffing → ready → open ↔ paused → closing → closed
                                                   closed → reopened
```

### Notification

```text
pending → processing → sent
                  ↘ partial/retry → processing
                  ↘ failed/cancelled
```

Transitions are implemented as pure helpers plus mutation-side authorization and invariant checks. Clients do not assemble status strings.

## 11. Transactional invariants

### Identity

- one `users` row per active Clerk subject;
- one active identity link per provider subject;
- one consumed result per auth intent;
- one event membership per user/event;
- VIT membership must reference a passed hosted-domain verification;
- no capability from participant account class.

### Team

- one active team membership per participant/event;
- one lead per active team;
- active team size within the published policy;
- one active project profile and one active project version pointer;
- one active table assignment per team and per physical table window.

### Reviewer/panel

- no active reviewer assignment through a confirmed conflict;
- no overlapping panel membership that makes attendance impossible;
- published panel meets configured size and criterion coverage or carries an active override;
- one accepted substitution candidate per missing slot.

### Queue/review

- one live queue entry per team/round;
- one live team-panel assignment per team/round;
- one non-voided review session per team/round;
- one active lease epoch and holder per session;
- every presence/scoring command matches the current session epoch;
- review cannot start without current assignment, table, presence, coverage, and conflict checks;
- queue completion and review completion change atomically.

### Scoring

- a reviewer can score only granted criteria for their active session;
- score in the frozen rubric range;
- one initial submission per reviewer/criterion/session;
- correction forms an immutable version chain;
- peer drafts remain undisclosed before policy permits;
- session completion requires configured criterion coverage and submitted groups;
- round close requires a disposition for every eligible team.

### Operations

- one command receipt per actor/client mutation ID;
- every accepted privileged command has an audit event;
- external side effects originate from an outbox job;
- high-risk override has capability, reason, scope, actor, and active time window.

### Synesthesia

- one active vote per user/request;
- one active playback lease;
- catalogue duplicates merge without losing vote attribution.

## 12. Example critical definitions

The implementation uses full validators and return validators. This abbreviated shape shows the intended keys:

```ts
queueEntries: defineTable({
  eventId: v.id("events"),
  roundId: v.id("rounds"),
  teamId: v.id("teams"),
  panelId: v.id("panels"),
  status: queueStatus,
  orderingKey: v.string(),
  priorityClass: v.string(),
  version: v.number(),
  updatedAt: v.number(),
}).index("by_round_team", ["roundId", "teamId"])
  .index("by_panel_status_order", ["panelId", "status", "orderingKey"]),

reviewSessions: defineTable({
  eventId: v.id("events"),
  roundId: v.id("rounds"),
  teamId: v.id("teams"),
  panelId: v.id("panels"),
  queueEntryId: v.id("queueEntries"),
  status: reviewSessionStatus,
  rubricVersionId: v.id("rubricVersions"),
  configRevisionId: v.id("eventConfigs"),
  leaseEpoch: v.number(),
  leaseExpiresAt: v.optional(v.number()),
  version: v.number(),
}).index("by_round_team", ["roundId", "teamId"])
  .index("by_status_lease_expiry", ["status", "leaseExpiresAt"]),

commandReceipts: defineTable({
  eventId: v.id("events"),
  actorUserId: v.id("users"),
  clientMutationId: v.string(),
  commandName: v.string(),
  requestHash: v.string(),
  result: v.any(),
  createdAt: v.number(),
}).index("by_actor_client_mutation", ["actorUserId", "clientMutationId"]),
```

`v.any()` in the abbreviated example is replaced by command-specific safe result unions or a deliberately constrained shared receipt result in production.

## 13. Schema evolution

- Add optional fields before clients depend on them.
- Deploy backend readers that tolerate old/new shapes before writers produce the new shape.
- Backfill with resumable paginated internal jobs.
- Record migration name, cursor, counts, errors, and completion.
- Never rename/remove an enum value while a supported mobile runtime may send it.
- Gate incompatible command versions with `supportedClientPolicy` and a human-readable update requirement.
- Keep old read projections during the compatibility window; remove only after telemetry shows no supported client uses them.
- Rebuild derived projections from canonical records after migration.

## 14. Retention and redaction classes

| Class | Examples | Default direction |
| --- | --- | --- |
| Identity/contact | email, phone, registration number | shortest approved operational/legal period |
| Event operations | assignments, queue, presence, timers | event plus audit/review period |
| Judging outcome | submitted scores, evidence, decisions | longer integrity/appeal period |
| Security/audit | privileged actions, auth failures | security policy period with restricted access |
| Device/notification | push tokens, device health | revoke immediately; purge after operational period |
| Local draft | reviewer encrypted outbox | purge after receipt/recovery window or logout resolution |
| Synesthesia | requests/votes/history | short event/abuse-review period |

Erasure replaces direct personal fields with approved redacted markers while preserving referential and outcome integrity. The exact periods remain an event-board/security decision.

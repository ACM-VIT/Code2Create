# Backend function catalog

## 1. Function design

This catalog defines the initial Convex API by user intent. Names may be refined during implementation, but capabilities, authorization, idempotency, and transactional boundaries are requirements.

Rules:

- Public functions are the smallest safe API exposed to web/mobile clients.
- Queries return role-filtered projections, not raw database documents.
- Mutations represent commands and own all invariant checks.
- Actions perform external I/O only.
- Internal functions are inaccessible to clients.
- Every function has argument and return validators.
- Public errors use stable codes and safe structured details.
- Sensitive writes read current grants server-side.

## 2. Shared command envelope

Outcome-affecting mutations accept:

```ts
{
  eventId,
  clientMutationId,
  deviceId?,
  commandSchemaVersion,
  expectedVersion?,
  configRevisionId?,
  assignmentRevision?,
  leaseEpoch?,
  reason?
}
```

Successful result:

```ts
{
  receiptId,
  commandName,
  acceptedAt,
  idempotentReplay,
  target: { type, id, version? },
  relatedVersions?,
  safeSummary
}
```

Common errors:

- `UNAUTHENTICATED`
- `USER_INACTIVE`
- `CAPABILITY_REQUIRED`
- `SCOPE_MISMATCH`
- `RECENT_AUTH_REQUIRED`
- `CONFIG_REVISION_MISMATCH`
- `VERSION_CONFLICT`
- `INVALID_TRANSITION`
- `INVARIANT_FAILED`
- `LEASE_STALE`
- `IDEMPOTENCY_KEY_REUSED`
- `UNSUPPORTED_CLIENT`
- `RATE_LIMITED`

## 3. Viewer and identity

### Public queries

| Function | Purpose |
| --- | --- |
| `viewer.me` | Current user, event membership, account class, profile completion, safe capabilities, next route |
| `viewer.events` | Events available to the current identity |
| `viewer.devices` | Current user’s registered devices and revocation state |
| `auth.intentStatus` | Safe state for current auth-intent nonce; never returns stored hash/details |

### Public mutations

| Function | Capability | Transaction |
| --- | --- | --- |
| `auth.createParticipantIntent` | anonymous/rate-limited | Create short-lived hashed VIT/External intent |
| `auth.requestReclassification` | `profile.manage_own` | Create pending request; no class change |
| `auth.claimRosterInvitation` | authenticated | Consume exact invite and create conditional grants |
| `auth.revokeOwnDevice` | authenticated owner | Revoke device and disable tokens |
| `profiles.updateOwn` | `profile.manage_own` | Patch allowlisted profile fields/version |
| `profiles.acceptTerms` | authenticated member | Record immutable terms acceptance |

### Public action

`auth.completeParticipantProvisioning`

External I/O:

1. retrieve Google OIDC token through Clerk backend;
2. validate Google claims;
3. call internal mutation `auth.commitParticipantProvisioning` with verified claim subset.

It returns no Google credential.

### Internal

- `auth.commitParticipantProvisioning`
- `auth.refreshIdentityVerification`
- `auth.expireIntents`
- `auth.suspendUser`
- `auth.mergeUsers`

## 4. Teams and projects

### Queries

| Function | Projection |
| --- | --- |
| `portal.teamHome` | Own team, members, profile status, check-in/table/readiness summary |
| `portal.projectEditor` | Current allowed draft/version and prompt completion |
| `portal.projectBrief` | Readable canonical current/submitted brief |
| `teams.invitationPreview` | Safe team/invite details before acceptance |
| `shortlisting.workspace` | Paginated authorised project/eligibility projection |

### Mutations

| Function | Capability | Core invariants |
| --- | --- | --- |
| `teams.create` | `team.create` | One active team/user; event open |
| `teams.invite` | `team.invite` | Lead, team size, invite dedupe/expiry |
| `teams.acceptInvite` | participant | Invite valid; no other active team; size |
| `teams.declineInvite` | participant | Invite belongs to user/context |
| `teams.removeMember` | `team.manage_own` or admin | Lead/size/submission policy |
| `teams.transferLead` | `team.manage_own` | New lead active; one lead |
| `projects.saveAnswer` | `project.edit_own` | Draft/version/field allowlist |
| `projects.updateLinks` | `project.edit_own` | URL/source policy and revision |
| `projects.submit` | `project.submit_own` | Membership, completeness, disclosures, content hash |
| `projects.createRevision` | `project.edit_own` | Allowed stage and prior version |
| `shortlisting.recordDecision` | `shortlist.decide` | Immutable decision/reason and eligibility |

Project submit atomically creates immutable version, advances profile/team state, command receipt, and audit/domain events.

## 5. Check-in, tables, and QR

### Queries

- `portal.checkinStatus`
- `portal.currentTable`
- `ops.checkinDesk`
- `ops.tableMap`
- `ops.tableExceptions`

### Mutations

| Function | Capability | Notes |
| --- | --- | --- |
| `checkin.recordPerson` | `ops.manage_checkin` | Append check-in event |
| `checkin.confirmTeam` | `ops.manage_checkin` | Team eligibility/member policy |
| `tables.assignTeam` | `ops.manage_tables` | No overlap; closes prior assignment |
| `tables.confirmOwn` | `team.manage_own` | Assignment/current confirmation window |
| `tables.moveTeam` | `ops.manage_tables` | Atomic end/create, reason required |
| `tables.markUnavailable` | `ops.manage_tables` | Rehomes/flags affected teams |
| `qr.issueTeamPresenceToken` | own team/assigned reviewer | Short-lived signed scope |
| `presence.verifyFromQr` | `review.scan_presence` | Signature, expiry, assignment, panel, conflict, replay, epoch |
| `presence.staffFallback` | `ops.verify_presence` | Reason, manual verification, audit |

QR issue returns the token only to an authorised short-lived request and never stores a reusable bearer credential.

## 6. Reviewers and grants

### Queries

- `reviewer.profile`
- `reviewer.trainingStatus`
- `reviewer.availability`
- `reviewAdmin.reviewerRoster`
- `reviewAdmin.coverageGaps`
- `reviewAdmin.conflictMatrix`

### Mutations

| Function | Capability |
| --- | --- |
| `reviewers.updateProfile` | own reviewer profile |
| `reviewers.declareExpertise` | own pending claim |
| `reviewers.verifyExpertise` | `review_admin.manage_reviewers` |
| `reviewers.declareConflict` | own reviewer |
| `reviewers.resolveConflict` | `review_admin.manage_conflicts` |
| `reviewers.setAvailability` | own reviewer |
| `reviewers.clockIn` | `reviewer.clock_in` |
| `reviewers.pause` | own reviewer |
| `reviewers.grantCriterion` | `review_admin.manage_grants` |
| `reviewers.activateGrant` | `review_admin.manage_grants` |
| `reviewers.revokeGrant` | `review_admin.manage_grants` |

Grant mutations write role/criterion grant history and invalidate active projections immediately.

## 7. Panels and assignments

### Queries

- `reviewer.panel`
- `reviewAdmin.panelPlan`
- `reviewAdmin.panelCoverage`
- `reviewAdmin.assignmentRecommendations`
- `ops.panelBoard`

### Mutations

| Function | Capability | Transaction |
| --- | --- | --- |
| `panels.createDraft` | `review_admin.manage_panels` | Create versioned draft panel |
| `panels.addMember` | same | Conflict/availability/coverage checks |
| `panels.removeMember` | same | Coverage warning/block |
| `panels.publish` | same | Freeze/publish membership revision |
| `panels.assignTeam` | `review_admin.assign_teams` | One live assignment, conflict/fit snapshot |
| `panels.acceptRecommendation` | same | Persist recommendation reasons |
| `panels.reassignTeam` | `ops.reassign_team` | Update assignment and queue atomically |
| `panels.pause` | `ops.manage_panels` | Hold impacted current/next work |

Recommendation generation may be a deterministic internal query/mutation or an offline planning job. It cannot silently publish assignments.

## 8. Paging and substitution

### Queries

- `reviewer.now`
- `reviewer.activePage`
- `ops.activePages`
- `ops.substitutionDetail`

### Mutations

| Function | Capability | Core behavior |
| --- | --- | --- |
| `pages.create` | `ops.page_reviewer` | Create page + notification outbox |
| `pages.acknowledge` | target reviewer | Record delivery/open acknowledgement |
| `pages.accept` | target reviewer | Race-safe acceptance + membership + coverage |
| `pages.decline` | target reviewer | Reason + next candidate scheduling |
| `pages.cancel` | `ops.page_reviewer` | Resolve job/page |
| `substitutions.start` | `ops.manage_substitution` | Snapshot missing slot and candidates |
| `substitutions.forceAssign` | `board.force_assignment` | High-risk reason; conflicts remain separate gate |

Scheduled internal jobs:

- expire unanswered page;
- create next candidate page;
- escalate exhausted substitution;
- alert on unacknowledged critical page.

## 9. Queue

### Queries

- `portal.queueStatus`
- `reviewer.nextAssignments`
- `ops.queueBoard`
- `ops.queueExceptions`
- `ops.queueCapacity`

### Mutations

| Function | Capability | Invariants |
| --- | --- | --- |
| `queues.declareReady` | `queue.declare_ready` | Team/table/deliverables/current round |
| `queues.withdrawReady` | `queue.withdraw_own` | Allowed pre-call state |
| `queues.callTeam` | `ops.manage_queue` | Current assignment/panel state |
| `queues.acceptCall` | assigned panel | Panel/work state |
| `queues.placeHold` | own limited or ops | Allowed code/reason |
| `queues.releaseHold` | ops/team per policy | Fair re-entry policy |
| `queues.markMissed` | `ops.manage_queue` | Called timeout |
| `queues.reprioritize` | `ops.reprioritize_queue` | Reason and policy checks |
| `queues.transferPanel` | `ops.reassign_team` | Coverage/conflict + queue transaction |
| `queues.cancel` | scoped admin | Disposition required |

Queue mutations own ordering keys and recompute participant-safe estimates where feasible.

## 10. Review session and timer

### Queries

- `reviewer.activeSession`
- `portal.reviewStatus`
- `ops.reviewDetail`
- `ops.activeReviewLeases`

### Mutations

| Function | Capability | Invariants |
| --- | --- | --- |
| `reviews.acquireLeaseAndStart` | `panel.start_review` | Presence, assignment, conflict, unique team/round |
| `reviews.renewLease` | current holder/member | Current epoch; bounded extension |
| `reviews.pause` | assigned panel/ops | Current epoch; reason |
| `reviews.resume` | assigned panel/ops | Current epoch; resolved blocker |
| `reviews.requestExtension` | assigned reviewer | Policy, count, current timer |
| `reviews.decideExtension` | policy or admin | Capability/limit/reason |
| `reviews.recordEvidence` | `review.observe` | Current session/epoch/visibility |
| `reviews.recordCommitment` | assigned reviewer | Required stage/version |
| `reviews.beginSubmission` | assigned panel | Required reviewer state |
| `reviews.complete` | `panel.complete_review` | Scores/coverage/evidence/timer/receipts |
| `reviews.void` | `board.override` | Step-up, reason, replacement disposition |

Timer queries derive current display from append-only timer events. No per-second mutation exists.

## 11. Scoring

### Queries

| Function | Visibility |
| --- | --- |
| `scoring.ownWorkspace` | Own granted criteria and own saved/submitted values |
| `scoring.sessionCompletion` | Completion booleans/counts; no peer values during active review |
| `scoring.roundCompletion` | Authorized missing-input/coverage projection |
| `scoring.submittedSession` | Review admin after configured lock/reveal |
| `scoring.teamAggregate` | Authorized/frozen aggregate plus policy revision |
| `scoring.anomalies` | Authorized statistical flags; no automatic correction |

### Mutations

| Function | Capability | Transaction |
| --- | --- | --- |
| `scores.saveServerDraft` | `review.score_assigned` | Optional online draft, own only |
| `scores.submitOwn` | same | Validate all granted criteria; immutable submission group |
| `scores.requestCorrection` | own submitted reviewer | Create request/reason |
| `scores.approveCorrection` | `review_admin.correct_score` | Policy/deadline |
| `scores.submitCorrection` | authorized reviewer | New immutable versions |
| `scoring.freezeRound` | `review_admin.freeze_scoring` | Completeness checks |
| `decisions.recordAdvancement` | `board.publish_decision` | Frozen aggregate/policy/evidence |

Aggregation is a pure versioned function applied to submitted active score versions. It never writes back “normalized” reviewer scores.

## 12. Operations and rounds

### Queries

- `ops.commandSummary`
- `ops.exceptions`
- `ops.roundReadiness`
- `ops.incidents`
- `ops.unsupportedClients`
- `rounds.current`
- `rounds.closeChecklist`

### Mutations

| Function | Capability |
| --- | --- |
| `rounds.publishPlan` | `review_admin.configure_round` |
| `rounds.open` | `review_admin.control_round` |
| `rounds.pause` | `review_admin.control_round` |
| `rounds.beginClosing` | `review_admin.control_round` |
| `rounds.close` | `board.close_round` |
| `rounds.reopen` | `board.reopen_round` + recent auth |
| `overrides.request` | capability for blocked rule |
| `overrides.grant` | `board.override` + recent auth |
| `overrides.revoke` | same |
| `incidents.open` | `ops.manage_incident` |
| `incidents.activateMode` | incident commander capability |
| `incidents.resolve` | incident commander |
| `configs.publishRevision` | `review_admin.publish_config` |

Round close mutation refuses any checklist blocker unless a specific active override supplies a documented disposition.

## 13. Notifications

### Queries

- `reviewer.notificationHealth`
- `ops.notificationHealth`
- `ops.pageDeliveryDetail`

### Mutations

- `devices.register`
- `devices.heartbeat`
- `notifications.registerToken`
- `notifications.disableToken`
- `notifications.acknowledgePage`
- `notifications.updatePermission`

### Internal actions/mutations

- `notifications.dispatchDue`
- `notifications.sendExpoBatch`
- `notifications.recordTickets`
- `notifications.fetchReceipts`
- `notifications.recordReceipts`
- `notifications.retryOrFail`
- `notifications.disableDeadTokens`
- `notifications.escalateUnacknowledged`

No client can directly choose arbitrary recipient tokens or message bodies.

## 14. Audit, exports, and reconciliation

### Queries

- `audit.search`
- `audit.targetHistory`
- `commands.lookupOwnReceipt`
- `ops.reconciliationSummary`
- `exports.list`

### Mutations/actions

| Function | Type |
| --- | --- |
| `commands.lookupOwnReceipt` | query after ambiguous network result |
| `exports.request` | mutation creates versioned job |
| `exports.generate` | internal action reads frozen snapshot |
| `exports.commitResult` | internal mutation stores checksum/reference |
| `exports.requestDownload` | mutation returns short-lived authorized access |
| `reconciliation.runChecks` | internal scheduled query/mutation |
| `reconciliation.createException` | internal mutation |
| `redaction.request` | privileged mutation |
| `redaction.execute` | internal action/mutation with approval |

Exports include event/config/rubric revisions, generation time, checksum, filters, and actor.

## 15. Synesthesia

### Queries

- `synesthesia.searchCatalog`
- `synesthesia.participantQueue`
- `synesthesia.ownRequests`
- `synesthesia.moderationQueue`
- `synesthesia.playbackControl`

### Mutations

| Function | Capability |
| --- | --- |
| `songs.request` | `synesthesia.request` |
| `songs.vote` | `synesthesia.vote` |
| `songs.removeVote` | `synesthesia.vote` |
| `songs.report` | participant |
| `songs.moderate` | `synesthesia.moderate` |
| `playback.acquireLease` | `synesthesia.control` |
| `playback.enqueue` | `synesthesia.control` |
| `playback.start` | `synesthesia.control` |
| `playback.skip` | `synesthesia.control` |
| `playback.pauseForAnnouncement` | `synesthesia.control` |

Vote mutation creates/removes the unique active vote and changes the request counter in one transaction.

## 16. Scheduled jobs

| Cadence/trigger | Job |
| --- | --- |
| Frequent during live rounds | expired lease/page/notification checks |
| Every few minutes | panel/reviewer heartbeat and unsupported-client exceptions |
| At configured thresholds | round reminders, clock-in escalation, queue-window recomputation |
| After notification send | receipt fetch/retry |
| At round close | reconciliation checks and signed export request |
| Daily/off-event | auth-intent/invite expiry, retention tasks, projection verification |
| On demand | projection rebuild, migration, restore validation |

Jobs process bounded batches with cursors and reschedule themselves. They are idempotent and emit health metrics.

## 17. Rate-limit classes

| Class | Examples | Strategy |
| --- | --- | --- |
| Auth anonymous | create intent, invite preview | IP/browser/nonce rate limits and abuse checks |
| Human command | ready, page response, score submit | user/device command limits; idempotency |
| QR | issue/verify | team/reviewer/device/round limits |
| Synesthesia | request/vote/search | stricter user/event burst limits |
| Operations | queue moves/pages | actor limits plus anomaly alert, not fragile UI throttling |
| Export | generate/download | capability, concurrency, audit, short-lived link |

Rate limiting never replaces authorization or idempotency.

## 18. Function acceptance checklist

Before a public function is complete:

- args and returns validated;
- authentication requirement explicit;
- capability/scope test exists;
- indexed data access reviewed;
- visibility/redaction test exists;
- idempotency policy defined;
- expected version/state transition enforced;
- audit/domain event defined;
- external side effects use outbox;
- errors have stable safe codes;
- empty/loading/retry/reconnect UI exists;
- backward compatibility with supported mobile runtime checked;
- metrics and runbook ownership assigned.

# Data model and realtime

## 1. Conventions

- Convex document IDs are the internal references.
- Every event-scoped record contains `eventId`, even when it can be reached through another record. This keeps authorization and indexes direct.
- Server time is stored as Unix milliseconds in UTC. Event display uses the configured IANA timezone.
- Mutable operational records contain an integer `version`.
- Status replaces deletion for event, judging, audit, and integration records.
- Submitted proposal and scorecard versions are immutable.
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

### `eventAccessSubjects`

One person’s security boundary inside one event, whether they arrived as a participant, rostered staff/judge, or an explicitly invited account.

Key fields:

- `eventId`, `personId`;
- copied display name and normalized verified email for event-scoped lookup, refreshed from the person record;
- `status: active | suspended | closed`;
- `linkedBy: participant_provisioning | roster_claim | access_invitation`;
- current status-change actor, time, and reason when suspension/reactivation has occurred;
- monotonic `accessVersion`, incremented whenever a role label, grant, revocation, bundle application/migration, assignment-sourced grant set, or subject status changes.

Every permission grant references an active event access subject. An account outside the event cannot receive a grant merely because its global person ID is known. An access invitation names one exact email and event without exposing a browseable global directory. The matching verified Google identity must claim it before a subject exists; the claim creates no grant. Suspension and reactivation use separate protected commands. Suspension denies all grants; reactivation does not recreate expired or revoked grants.

`access.subjects.suspend` and `access.subjects.reactivate` resolve the exact target person inside the event and are independently grantable. Each command checks the target's `accessVersion`, session age, reason, and current state in one mutation. Suspension rejects the actor's own person ID. The subject status and version change without editing a permission or role row; audit captures the number of effective grants at the boundary change.

### `eventAccessInvitations`

One short-lived authorization for an exact Google email to become an event access subject.

Key fields:

- `eventId`, `emailNormalized`;
- `status: pending | claimed | revoked | expired`;
- `validUntil`, constrained to five minutes through 30 days at creation;
- monotonic `version`;
- creator, creation operation ID, reason, and created time;
- claimed person/subject, claim operation ID, and claimed time when claimed;
- revoking person, revoke operation ID/reason, and revoked time when revoked.

At most one effective pending invitation exists for an event/email. Creation, claim, and revocation are idempotent operations. Creation and revocation require event-scoped `access.subjects.invite` plus a current scoped authorization. Claim requires the exact verified Google email, not a permission grant. Claim, revoke, and the version-guarded scheduled expiry all read and write the same invitation record, so only one state transition commits. A delayed expiry job cannot invalidate a claim because its expected version no longer matches.

### `eventMemberships`

One event access subject’s participant state. Staff/judges who are not participants still have an `eventAccessSubject` but no participant membership.

The VIT or External button choice is temporary browser UI state, not a database record. It grants no authority. Provisioning derives the stored class from the verified Google hosted-domain claim and the event's approved-domain list.

Key fields:

- `eventId`, `personId`, `eventAccessSubjectId`
- `participantClass: vit_student | external | none`
- `eligibilityStatus: pending | eligible | rejected | suspended`
- `onboardingStatus: profile_required | github_required | team_required | project_required | ready_to_submit | submitted | selected | offer_pending | accepted`
- exact `acceptedParticipantPolicyVersionIds`;
- `googleHostedDomain?`
- `createdAt`, `updatedAt`

One active membership exists per event/person.

`github_required` means the profile is complete but the participant has not completed the mandatory SGLang contribution step. The server requires a `githubStarCompletion` before team creation, team joining, or imported-team acceptance.

### `participantEligibilityImports`

One immutable production registration-list import for an event.

Key fields:

- `eventId`, stable batch key, and `status: preparing | active | superseded`;
- expected external and VIT identity counts;
- SHA-256 checksums for the external and VIT source workbooks; and
- creation, activation, and optional supersession times.

The server can create or activate an import only in production and only while the event is closed. Rows arrive in bounded batches. Publication requires exact agreement with both expected counts. It changes `events.publishedParticipantEligibilityImportId` and supersedes the prior import in one transaction. A failed or incomplete import remains inactive.

### `participantEligibilityEntries`

One normalized identity from a participant registration list.

Key fields:

- `eventId` and `participantEligibilityImportId`;
- `participantClass: vit_student | external_participant`;
- `identityKind: vit_registration | email` and its normalized value;
- original source row number and creation time.

External entry checks use the exact normalized verified Google email. VIT entry checks first require the approved Google Workspace domain and hosted-domain claim, then use the registration number parsed from the verified Google display name. The table stores no participant name, team assignment, profile answer, or workbook contents. Every production participant read and mutation rechecks the active event import. Staging uses a separate code-owned tester list.

### `teamRosterImports`

One immutable, preview-confirmed participant team-roster import. It stores the event, source name and optional filename, preview checksum, row and outcome counts, audited reason, authorizing grant IDs, creator, operation ID, and creation time. Confirmation inserts pending assignment rows only. It never creates a team or membership and `appliedNowCount` remains zero.

### `teamRosterEntries`

One participant's imported team offer and provenance. It stores one exact normalized Google email or VIT registration number, display name, team name, listed `lead | member` role, source row, monotonic version, and `pending | waiting_for_lead | identity_conflict | choice_required | claimed | revoked | superseded` status.

`pending` means the participant has not accepted. `waiting_for_lead` means a listed member accepted but the listed lead has not formed the team. `choice_required` means the participant was already on another team when the row was imported. `claimed` records the exact membership, team, and time when available. Import, provisioning, GitHub completion, and refresh do not advance these states.

The exact participant can accept or leave a current pending offer after profile, policy, GitHub, eligibility, permission, identity, and version checks. Acceptance is transactional. A lead acceptance creates the team and joins only same-team rows already in `waiting_for_lead`; a member acceptance waits when no live team exists. A participant who already has another team supplies its exact ID and version, and all leave and join changes commit together. A later import can supersede a still-open row but cannot rewrite a claimed membership.

### `githubStarSetupIntents`

One short-lived, participant-scoped classic GitHub OAuth App authorization attempt. It stores the event, membership, person, hashed state, encrypted PKCE verifier, exact redirect URI, status, claim lease, expiry, and completion or failure metadata. The callback must contain the matching state and OAuth code. Raw OAuth state and tokens are never stored. A scheduled mutation expires unused attempts.

### `githubStarAuthorizations`

One temporary GitHub OAuth authorization for a participant who connected GitHub but has not completed the star. It stores the event, membership, person, GitHub user ID/login, encrypted access token, hard expiry, and an optimistic provider-call lease. One GitHub user can be active for only one membership in an event. After the star succeeds, the provider grant is revoked and the record is deleted immediately.

### `githubStarCompletions`

One durable completion per event/membership. It stores the participant and GitHub identities, the fixed `sgl-project/sglang` repository identity, and server completion time. The same GitHub user cannot complete the step for two participants in one event. It stores no OAuth credential.

`selected` means the human acceptance is published but no offer is open. `offer_pending` means the exact deadline-frozen roster has reserved places and awaits its current lead. `accepted` is deliberately the final membership state after offer confirmation and is the only one of those three that enables attendance and review queues.

### `eventRoles`

One organizational label per event/person.

Key fields:

- `eventId`, `personId`, `eventAccessSubjectId`
- `role: supreme | board | sc | jc | external_judge`
- `validFrom`, `validUntil`
- `status: active | replaced | revoked | expired`
- `sourceType: production_seed | roster | manual`
- `sourceId`
- `assignedByPersonId`
- `createdAt`, assignment reason;
- `endedAt?`, `endedByPersonId?`, and `endReason?` for replaced, revoked, or expired rows.

Protected functions do not query this table to authorize a request. The role is used for roster grouping, display, training, and selecting a code-owned default template. The role command expands that template, validates every grant or removal against the actor's separate ceiling, and changes only `role_template` grants attributed to the affected role row. Versioned permission bundles remain separate.

The deployed set command checks `access.roles.assign` for the target person, the subject's optimistic `accessVersion`, a current scoped authorization, and a reason. It expands the selected and prior templates before writing, checks every planned addition/removal against the actor's grant/revoke ceiling, ends the one active row, revokes only that row's template grants, inserts a replacement when requested, materializes the replacement template, and increments the subject version in the same transaction. Clearing a role inserts no sentinel row.

### `rosterImports`

One immutable, preview-confirmed staff/reviewer CSV operation.

Key fields:

- `eventId`, source name, optional source filename, reason, and creator;
- shared `validFrom` and event-bounded `validUntil`;
- up to eight `{ bundleId, bundleVersionId, bundleChecksum }` selections;
- configuration and full-preview checksums;
- source-row, created, replaced, unchanged, and already-claimed counts;
- exact authorizing grant IDs, client operation ID, and creation time.

The import does not store arbitrary scope bindings. Only current published bundles that resolve without a named resource or participant membership may be selected. Confirmation creates the import and every required pending row, and supersedes the exact prior pending rows, in one transaction.

### `rosterEntries`

One approved staff/reviewer identity claim and its immutable import provenance.

Key fields:

- `eventId`, `rosterImportId`, and original source row number;
- exact normalized verified Google email, display name, and `supreme | board | sc | jc | external_judge` role label;
- pinned configuration checksum, `validFrom`, and `validUntil`;
- `status: pending | claimed | revoked | superseded | expired` and monotonic version;
- creator and creation time;
- optional claimed person, event access subject, event role, permission-grant batch IDs, Better Auth user, Google subject, operation, and time;
- optional superseding row/time, revoker/operation/reason/time, or expiry time.

Claiming reloads and checksum-validates the import and every pinned bundle version. Creating/reusing the event subject, creating or validating its role, materializing its code-owned template when one exists, materializing every missing atomic bundle grant, completing their source-attributed batches, linking the verified identity, and marking the row claimed happen in one mutation. A later import never edits a claimed row.

### Code-owned permission catalog

Permissions are definitions in version-controlled server code, not editable database rows. Every definition contains:

- one stable key and plain-language purpose;
- allowed scope types and whether event-wide scope is legal;
- a closed schema for optional constraints;
- current authorization, reason, device, and audit requirements;
- the protected queries/commands allowed to require that key.

Permission-key meaning is immutable. A newly protected operation or broader scope gets a new key rather than silently expanding existing grants. Safety constraints may narrow immediately; removing a key requires a migration that finds affected grants first.

The build fails when a protected public function has no declared permission key, references an unknown key, or asks for a scope type the key does not allow. Runtime scope resolution loads the target and its indexed ancestors; it never trusts a client-provided parent, string prefix, or role. The catalog has no wildcard entry and accepts no runtime-created key.

### `permissionBundles`

The code-owned **Emergency Reviews** preset publishes a JC bundle containing event-scoped `application.review_deck.use` and `application.profile_context.read`. It can be assigned to an existing person or pinned to an exact-email roster import. It opens only the admissions review deck: claiming a current submission grants access to that project, its submitted participants and their year/institution, its previous human reviews, and the review form. It grants no application-list, aggregate-statistics, decision, or other operations access. Detail access requires an unexpired claim or a completed assignment for the current submission version, plus the still-active bundle permission; releasing the claim or ending that permission removes access without leaving application-scoped grants behind.

The stable identity for one convenience template. It never authorizes directly.

Key fields:

- `eventId`, immutable stable key, current label, and optional suggested role label;
- `status: active | retired`;
- optional current published-version and editable-draft pointers;
- monotonic published version and object version;
- creator and timestamps.

The stable identity is the exact resource used by bundle read, publish, and apply grants. Its pointers are checked against the referenced version status on every protected read or mutation.

### `permissionBundleVersions`

Immutable published/retired versions plus the one editable draft for a bundle. They never authorize directly.

Key fields:

- `eventId`, stable bundle identity/key, label, and optional suggested role label;
- semantic version, draft revision, and `status: draft | published | retired`;
- ordered entries containing one catalog permission key, exact scope type, `scopeSource: event | target | binding`, optional named binding, and `validityRule: bundle`;
- content checksum, created/updated actors and times, and optional publication/retirement facts.

There are 1–48 entries. Event scope resolves only from the event. Self scope resolves only to the target's own event subject or participant membership. Person scope can resolve to the target or a named binding. Every other resource scope uses a named binding. One binding name represents one resource type. Publishing revalidates every entry against the code-owned permission catalog. One mutation makes the draft immutable and retires the prior published version. Updating or publishing a bundle changes nobody's grants.

### `permissionGrantBatches`

One audited application or migration of a published permission-bundle version to one exact person.

Key fields:

- `eventId`, client operation ID;
- `action: apply_bundle | migrate_bundle`;
- actor person ID;
- exact target person, stable bundle, and destination published version IDs;
- for migration, the retired source-version ID and exact source application-batch ID;
- ordered resolved resource bindings used by this application;
- requested validity, reason, client operation fingerprint, and preview checksum;
- exact authorizing grant IDs and the access-version checked by the command;
- created/completed time, resulting destination-grant IDs/count, superseded source-grant IDs, preserved exception-grant IDs, and resulting access version;
- transaction-local `status: applying | complete`.

Retries return the original result. Applying a bundle to one person is one transaction: every missing grant in the resolved published set is created and the target access version advances once, or none is created. The deterministic source identity includes the published version, exact resolved scopes, target, and expiry, so an exact reapplication is idempotent while a different binding or expiry remains independently traceable.

A migration command contains one to five of these per-person batches and commits them in one Convex mutation. The command compares a retired source version with the current published version of the same stable bundle. It re-resolves destination bindings and preserves the source validity within the current event end. It records each add, replacement, removal, reuse, or preserved exception. Only current grants named by the selected source batches become `superseded`. A manual grant, another bundle source, and a revoked old- or destination-version grant remain untouched. Several selected applications for one person advance that subject's `accessVersion` once. The outer actor operation record makes an exact retry return the original batch set. A batch records convenience and provenance. Authorization always reads the individual grants.

The deployed backend exposes paginated `permissionBundleMigrations.sources` and `permissionBundleMigrations.candidates` queries, the no-write `permissionBundleMigrations.preview` query, and the transactional `permissionBundleMigrations.confirm` mutation. Candidate pages contain at most five application batches; source-version pages contain at most 20 versions.

### `permissionGrants`

The only application authorization record used by protected functions.

Key fields:

- `eventId`, `personId`, `eventAccessSubjectId`;
- stable `permissionKey`;
- deployed `scopeType: event | self | person | team | application | round | panel | review | page | scorecard | attendance_plan | attendance_session | station | incident | evidence_checkpoint | permission_bundle | roster_entry | synesthesia_window | song_request | support_case | rehearsal_run`;
- required `scopeId` except for intentional event scope;
- catalog-validated bounded constraints, never executable rules;
- optional `delegation` only on `access.permissions.grant_scoped | revoke_scoped`, containing one non-administrative permission key, exact legal scope, and `exact_person | any_event_person` target boundary;
- `validFrom`, optional `validUntil`;
- `status: scheduled | active | revoked | expired | superseded`;
- `sourceType: production_seed | participant_membership | team_membership | team_lead | role_template | bundle | application_assignment | panel_assignment | reserve_assignment | page_assignment | station_assignment | event_subject | manual | delegated`;
- `sourceId`, `grantBatchId`, `grantedByPersonId`, reason, and created time;
- optional materialized `activatedAt`, `expiredAt`;
- `revokedAt?`, `revokedByPersonId?`, `revokeReason?`.

Any event-linked person may hold any permission regardless of role. Several active grants may independently provide the same permission/scope; revoking one source does not remove access while another matching grant remains. Assignment teardown queries `sourceType + sourceId` and revokes only grants created by that assignment.

Current authorization reads use the exact subject/permission/status/scope index. One exact permission scope has at most 32 current independent owner rows, and one source has at most 256 current rows; the grant insertion boundary enforces both ceilings and rejects duplicate source ownership. Domain queries that intentionally enumerate scoped authority supply a product limit and fail when either the grant-row or distinct-resource ceiling is exceeded. They never truncate authority or scan a subject's complete grant history.

Participant provisioning and approved roster claim create three `event_subject`-sourced self grants for support case create, read, and reply. They are ordinary independently revocable grants, not hard-coded account powers. Reusing an existing subject does not recreate a revoked support grant. An access-invitation-only subject remains grantless until an authorized grant command explicitly adds a capability.

The schema does not predeclare placeholder scope types. A later feature adds its scope literal only in the same change that adds the event-ownership resolver, grant picker, protected command, and acceptance check. The exhaustive server switch and catalog typing make a new unresolved scope a compile failure rather than an inert grant.

`access.permissions.grant_any` is event-scoped and can grant any catalog key to any event-linked person. `access.permissions.revoke_any` separately revokes grants in that event; neither implies the other. Each `access.permissions.grant_scoped` or `access.permissions.revoke_scoped` row names one non-administrative permission key, one exact legal resource scope, an exact active target person or the explicit `any_event_person` value, and a required expiry. For grant authority, that same time is the latest expiry it may issue. Several delegation rows are required for several keys or resources. Target-owned self, reviewer-page, and reviewer-owned scorecard scopes cannot use the broad target boundary.

Grant and revoke commands reject cross-event targets, unknown or wildcard keys, missing/foreign scopes, invalid constraint combinations, an excluded target person, expiry beyond the actor’s ceiling, and self-escalation. Reading another person’s grants, looking up event people, assigning a role, importing a roster, publishing/applying/migrating bundles, granting, and revoking remain independent permission checks; a templated role assignment must satisfy both `access.roles.assign` and every applicable grant/revoke ceiling.

Direct grant and revoke batches contain one to twenty unique entries for one event access subject. A grant batch has one optional common expiry and one reason. A revoke batch names only current active or scheduled grant IDs and has one reason. The command validates every row and every authorizing grant before the first write. One batch cannot mix unrestricted and delegated authority. A successful grant batch uses `access.grant_batch:<clientOperationId>` as the common manual or delegated source, stores each grant as an ordinary `permissionGrants` row, advances the subject's `accessVersion` at most once, and records one aggregate operation result and audit event. A successful revoke batch revokes every selected row, advances the version once, and records the same aggregate evidence. These direct operations do not create `permissionGrantBatches`; that table remains provenance for versioned permission-bundle applications and migrations.

Grant authority never satisfies the underlying protected function. Scoped grant authority cannot issue any of the four grant/revoke-authority keys; issuing those requires `access.permissions.grant_any`.

Grant creation stores a future row as `scheduled` and atomically schedules state-checked internal mutations at its start and optional end. A 15-second repair sweep reads bounded `status + validFrom` and `status + validUntil` index ranges; when more due rows remain, it immediately schedules another batch. Exact jobs advance the affected subject’s `accessVersion`; a repair batch advances each affected subject once. Every path reloads current status, so revocation or supersession makes stale work a no-op. Protected functions also compare server time to `validFrom`/`validUntil`; delayed expiry materialization can make history briefly stale but can never extend access.

The row-insert boundary validates that `eventId`, `personId`, and `eventAccessSubjectId` identify one active account, then returns the exact grant ID and whether it created a row. Commands group related row inserts and advance the subject once only when that group created something. An idempotent source retry returns existing IDs and leaves `accessVersion` unchanged. A brand-new subject is committed with its initial grant set and version `1`; no client can observe the subject before that transaction commits.

### `reviewerDevices`

Reviewer installations. Attendance scanner identity and station assignment remain in `attendanceDeviceInstallations` and `attendanceStations`; using the same physical phone does not merge their permission boundaries.

Key fields:

- `eventId`, `personId`
- `installationId`
- `platform: ios | android`
- `appBuild`, `runtimeVersion`
- camera and encrypted-draft readiness;
- optional `pushToken`, its SHA-256 fingerprint, `pushProvider: fcm | apns`, and `pushEnvironment: development | production`, supplied and validated as one tuple;
- `pushTokenStatus: not_registered | active | invalid`, update time, and optional invalidation time/failure code;
- `status: active | revoked`;
- monotonic version, registration/revocation times, and `lastSeenAt`.

Android accepts only FCM with the production provider environment. iOS accepts only APNs and records whether the operating system issued the token for sandbox or production. One token fingerprint belongs to at most one event installation; registering the same valid native token on a replacement installation clears it from the prior row in the same transaction. A provider-rejected token cannot be reclaimed unchanged. Token refresh patches the exact active installation. A provider invalid-token response checks the stored token fingerprint again before invalidation, so a late result for an old token cannot disable its replacement.

### `participantProfiles`

Event registration details.

Key fields:

- `eventId`, `membershipId`
- full name, optional preferred/display name, and policy-permitted contact route;
- college/university/institution/organization and current year-of-study or current-role key;
- participant-class and deterministic admissions experience-band source fields;
- VIT registration/programme/campus fields when applicable;
- VIT hostel residence from the closed Vellore catalog (day scholar, men's blocks including B, ladies' blocks including S) and room number when the residence is a hostel block;
- external city/country fields when the accepted policy permits them;
- `profileVersion`
- `updatedAt`

For VIT participants, the stored full name comes from the verified VIT Google identity and cannot be replaced by the client. External participants send an event-facing full name because their Google display name is not authoritative. Contact numbers are normalized before storage. Shared domain validation rejects malformed or obvious placeholder names and numbers on both the client and the server.

Completeness is derived against an exact policy version; it is not stored as a boolean that can become stale after publication. Sensitive dietary, accessibility, or eligibility material belongs in its protected support/evidence record rather than this profile.

## 4. Event configuration

### `events`

- name, slug, timezone;
- authoritative `externalApplicationsCloseAt` and VIT `applicationsCloseAt`, check-in windows, and event window;
- status;
- active participant, admission, communications, attendance, integration, security, retention, and Synesthesia configuration IDs;
- published event-phase-schedule, project-checkpoint-plan, atomic intake-policy, novelty-corpus, admission-policy, and admission-model-configuration version IDs;
- published participant-eligibility-import ID;
- hosted-domain allowlist;
- active incident ID;
- production release metadata.

Versioned policies use policy-specific tables rather than one generic payload union. This keeps every stored shape, validator, index, and command compile-time explicit. The event row holds only each current published pointer plus core operational fields shared across domains. Published versions are immutable.

### `participantPolicyVersions`

One immutable registration and team-policy release.

- `eventId`, monotonic numeric version, and `status: draft | published | superseded | retired`;
- participant-facing label;
- positive whole-number team minimum/maximum chosen by operations, with the maximum no greater than the current published admission participant capacity;
- `not_collected | optional | required` modes for phone, VIT registration number, VIT programme, VIT campus, VIT hostel details, external city, and external country;
- profile-use notice, project-text processing notice, and credential-free HTTPS privacy-notice URL;
- the fixed fresh-project acknowledgment and a bounded final warning that states that the current application is submitted for review and team and proposal changes remain open until the applicable deadline;
- checksum, creator/time, and optional publication time.

One event has at most one draft and one published row. Draft replacement is optimistic and retires the previous draft. Publication revalidates the complete content, admission capacity, exact draft/checksum/event version, recent Google session, and reason. When the minimum increases or maximum decreases, the same transaction reads the bounded non-withdrawn event-team set and enough indexed active-member rows to prove every roster conforms. Withdrawn teams are history and do not block a future policy. An incompatible current roster blocks publication, and a concurrent join conflicts with that proof. A valid publication supersedes the old row and moves `events.publishedParticipantPolicyId` in the same transaction. `events` no longer duplicates team-size, warning, or participant-policy strings.

Event memberships retain the exact policy IDs that their owner accepted. Participant reads derive current completeness from membership acceptance, the published policy, and saved profile fields. An eligible participant can create or join a team after accepting the current publication even when the profile is incomplete. Join also checks capacity and requires every active member to have the same verified class. Final preview returns the exact policy ID, warning, and class-specific deadline. Submission rechecks that ID, every active member's acceptance and complete profile, team bounds, single-class roster, draft, lead, and applicable deadline in one transaction. It then pins the policy ID in the first immutable application snapshot. A later team change repeats those checks and creates a replacement current snapshot in the same transaction as the change.

### `communicationsPolicyVersions`

One immutable accepted-team and notification release.

- `eventId`, monotonic numeric version, and `status: draft | published | superseded | retired`;
- venue name, optional address and credential-free HTTPS map URL;
- start/end snapshot that must exactly match the event's operational window;
- one-to-eight ordered next steps with unique stable key, title, detail, optional internal/HTTPS action, and optional due time;
- official Discord invite URL and participant-facing label;
- fixed `notificationProvider: cloudflare_email | aws_ses` plus generic subject, text, HTML, and asset bundle per message type;
- checksum, creator/time, and optional publication time.

One event has at most one draft and one published row. Draft replacement retires the prior draft rather than editing it. Publication revalidates the complete content, exact current draft/checksum/event version, operational-window match, recent Google session, and reason, then supersedes the old row and moves `events.publishedCommunicationsPolicyId` in the same transaction. Venue/Discord fields do not live on `events` and never enter the unauthenticated public event response.

The production sender identity, reply-to, retention/redaction period, mandatory-message policy, and approved production copy remain release inventory decisions under O-034; the application does not expose unenforced retention controls. The introduction contract remains separately typed in `intakePolicyVersions`, and admission, attendance, integration, intelligence, novelty, phase, checkpoint, review, and Synesthesia configuration use their own tables.

### `eventPhaseScheduleVersions`

One immutable event-phase schedule release.

- `eventId`, monotonic version number;
- `status: draft | published | superseded | retired`;
- checksum, creator, creation time, and optional publication time.

An event points to at most one published schedule. At most one draft exists for that event. Saving a changed complete set retires the previous draft and its rows before creating the next version. Publishing changes the event pointer and version in the same transaction that marks the draft published and the prior published parent superseded.

### `eventPhaseWindows`

The five ordered rows owned by one schedule version.

- `eventId`, `scheduleVersionId`;
- `phaseKey: introduction | ideation | build | intermediate_update | final_update`;
- participant-facing display name and short description;
- `startsAt`, `endsAt`, and canonical `displayOrder`;
- `status: draft | published | retired` and creation time.

Every schedule contains each semantic key exactly once. A window lasts from one minute through fourteen days, windows do not overlap, and the first start through final end spans at most sixty days. Intentional gaps are valid. Publication uses current server time: a completed published row must remain byte-for-byte equivalent; a started row may change only its future `endsAt`; a future or newly introduced row cannot be placed in the past. Superseded schedule rows stay immutable so audit and older references preserve their meaning.

The unauthenticated event projection exposes only the current published rows and event timezone. Participant clients derive the current or next display row from that projection. Authoritative checkpoint state and generated-question routing do not come from the client clock.

### `intakePolicyVersions`

One immutable version owns the complete pre-event introduction contract. These values publish together because splitting the shell, fixed questions, generated route, safety wording, and model settings would allow combinations that were never reviewed.

- `eventId`, monotonic version, and `status: draft | published | superseded | retired`;
- fixed opening **Hello.**, fixed first prompt **What is your project about?**, concise help text, and initial-answer limits;
- follow-up answer limits, two required fixed questions, two required generated-or-fallback questions, and the generated-question length limit;
- unique allowed purpose keys from `user | problem | experience | event_goal | tradeoff | risk`;
- ordered question definitions with text, purpose, and `short | medium` answer length: one fixed definition for ordinals one and two, then at least two reviewed variants for each of fallback ordinals three and four;
- required prohibited wording plus optional additional blocked terms;
- zero to twenty reviewed common-idea patterns `{ stableKey, description, supportiveQuestionGuidance }`;
- model contract `{ mode: deterministic }` or `{ mode: assisted, modelId, systemInstruction, instructionVersion, schemaVersion, redactionVersion, questionPolicyVersion, evaluationSuiteVersion }`;
- checksum, creator, creation time, and optional publication time.

`events.publishedIntakePolicyId` points to the one published version. At most one draft exists. Saving a changed complete draft retires the previous draft; publishing requires that exact draft ID and checksum, the current event version, a recent Google session, and a reason. It marks the old published row `superseded` and moves the event pointer in the same transaction. A participant draft pins the published ID when the first idea is saved and never adopts a later publication.

The normalizer enforces the exact opening copy, numeric bounds, two-fixed-plus-two-generated-or-fallback contract, unique purposes and blocked terms, required safety terms, required variant counts, unique single-question wording, allowed purposes, unique pattern keys, and bounded assisted-model settings. The runtime hashes the team ID with the target ordinal to choose a stable fallback variant; the selected immutable question is then shared by every teammate. Generated output must reference active answer versions and provide one to three grounding terms copied from those answers. At least one grounding term must appear in the question. Common-idea patterns contain no prior participant text, institution, outcome, embedding, or copied summary. They can guide a supportive question but cannot become an admission criterion.

### `noveltyCorpusVersions`

One immutable published version owns the numeric display policy and curated comparison set.

- `eventId`, monotonic version, optimistic revision, and `status: draft | published | superseded | retired`;
- `importState: empty | running | ready | failed`;
- minimum idea length, debounce milliseconds, maximum team requests per minute, and whole-number score mapping;
- fixed `embeddingModel: text-embedding-3-small` and `embeddingDimensions: 1536`;
- entry count and optional checksum;
- optional active import operation/fingerprint and non-sensitive failure category;
- creator, last editor, creation/update time, and optional publication time.

Only one draft and one published row may exist per event. Draft creation requires `configuration.novelty.draft.create`; complete entry replacement requires `configuration.novelty.entries.write`; publication requires `configuration.novelty.publish`. Each is separate from `configuration.novelty.read`. Publication verifies the exact ready revision/checksum and event version, requires a recent Google session and reason, supersedes the prior published row, and moves `events.publishedNoveltyCorpusVersionId` in the same transaction. It changes no existing project draft.

### `noveltyCorpusEntries`

- `eventId` and owning `corpusVersionId`;
- unique reviewed `sourceKey` and source year;
- bounded non-identifying comparison summary;
- one finite 1,536-value embedding produced by `text-embedding-3-small`;
- creation time.

A corpus contains 5 to 300 entries. Source keys are unique. Source years cannot be later than the current server year. Summaries are bounded and non-identifying. The importer checks contact, identifier, and credential patterns before provider work. It embeds the complete normalized set without a dimensions override. It validates each provider result and replaces all child rows in one transaction. A partial provider batch never becomes a ready corpus.

### `noveltyTeamIdeas`

- `eventId`, `teamId`, and input fingerprint;
- lifecycle `editing | saved | submitted`;
- one finite native 1,536-value complete-idea embedding;
- source update time and index update time.

The table stores no raw idea. One team has at most one current row for editing and one current durable row for saved or submitted text. Each row is the complete idea; the provider request, response, and retrieval path contain no segment embeddings. Editing rows expire after the short live-edit window. If retrieval sees both rows, the durable row is authoritative and the editing row does not add or replace that team's density contribution. An authoritative idea change deletes all older rows and makes running preview requests stale in the same transaction. Provider failure after that transaction leaves no current replacement row and therefore cannot preserve an obsolete idea in density results.

Saved-draft replacement indexing is optional background work. A content change schedules it at a deterministic point in the next five minutes. It uses the sharded background budget without reserving capacity, so a burst can shed draft indexing instead of creating a future queue. Submitted replacement indexing uses the same sustained budget with reservations and drains completely; at most 1,500 future tokens can be reserved. The default is 300 embeddings per minute and is deployment-configurable through `NOVELTY_INDEX_REQUESTS_PER_MINUTE`. Each action carries only authoritative record IDs, fingerprints, timestamps, retry count, and, for submitted work, reservation state. It reloads the current draft or submitted version before provider work. Provider failure gets no more than two retries. Participant preview capacity and proposal writes never wait for either path.

### `noveltyPreviewRequests`

- `eventId`, `teamId`, requesting `personId`, and pinned `corpusVersionId`;
- client request ID, normalized input fingerprint, and character count, but no raw idea text;
- `state: running | succeeded | unavailable | failed | stale`;
- optional whole-number score and internal nearest similarity;
- optional provider request ID, remaining-request/reset headers, latency, non-sensitive failure category, and request/completion time.

One team/client-request range makes the public action idempotent. A second use with different input fails. Exact running work for one team/input coalesces, and a successful same-team/corpus/fingerprint row may be reused for 30 seconds. The rate-limiter component enforces a sharded deployment budget and the published per-team minute budget without scanning preview history. A denied capacity request is settled as unavailable so event health includes load shedding. A sensitive-looking idea returns unavailable before a request row or provider call exists. Only a current successful request may be copied onto the mutable project draft; preview rows never become application, admission, review, or score evidence.

`noveltyPreviewRequests.by_team_state_requested` lets an accepted idea edit invalidate only that team's running requests without a table scan. A late action cannot store a team vector from a stale request.

### `admissionPolicyVersions`

One immutable release owns the complete human admissions contract.

- `eventId`, unique public version label, and `status: draft | published | superseded | retired`;
- the code-owned AI recommendation release marker;
- minimum human-review count from one through five and a positive whole-number overall participant capacity chosen by operations;
- one through twelve uniquely keyed criteria, each with a label and complete guidance for `firstYear`, `earlyYear`, `laterYear`, `postgraduateOrProfessional`, and `mixedOrExternal`;
- four through twenty uniquely keyed human decision reasons, each permitting one or more of `accept | waitlist | decline`, with every disposition covered by at least one reason;
- checksum, creator/time, and optional publication time.

The policy uses different guidance for each experience band. It is the public admission rubric. It is not a judging rubric. Novelty, institutional prestige, and judging facts are absent from its criteria.

### `admissionModelConfigVersions`

The model release is a code-owned child of exactly one admission-policy version.

- `eventId`, owning `admissionPolicyVersionId`, unique release label, and the same lifecycle status as its policy;
- approved OpenAI model ID plus prompt, Structured Output schema, and evaluation-suite version labels;
- checksum, creator/time, and optional publication time.

Draft replacement retires the previous policy and its model together. Publication checks the exact policy/model IDs and checksums, event version, current scoped authorization, reason, and idempotent operation ID. One mutation supersedes the prior pair, publishes the new pair, creates its empty overall `admissionCapacityBuckets` row, and moves both event pointers. Every new policy has its own matching model; provider failure affects only the advisory result and never blocks human review.

The first validating or finalizing submission attempt, and then the first submitted application, permanently closes admission draft replacement and publication for the event. Submission start pins the published pair on its durable attempt. Successful finalization copies that policy ID to the immutable proposal version and application. A publication and submission race has one serial result.

The durable Flue runtime has no operator-configured model-call timeout or output-token ceiling. Exact accepted-submission leases recover interrupted work without making the recommendation terminal. The separately reviewed runtime contract enforces a closed recommendation schema, exact criterion coverage, authorized source references, bounded explanations/questions, prohibited identity/prestige/judging language, actual model provenance, and human review on every provider failure. The version labels identify that approved contract; they are not a claim that an evaluation suite ran unless release evidence records that run.

### Configuration publication checks

Participant, admission, intake, novelty, phase, checkpoint, communications, and intelligence editors each replace one complete draft under separate scoped permissions. Session-pinned configuration publication never migrates active participant state. Admission publication closes permanently when the first submission attempt begins validating and remains closed once an application exists. Each validator has one boundary:

- intake validation owns opening, answer, question, fallback, safety, pattern, and model bounds;
- novelty import owns corpus safety, native embedding width, complete-set replacement, and similarity boundaries;
- phase validation owns the five ordered windows;
- checkpoint validation owns its three ordered definitions and phase references; and
- admission validation owns complete band guidance, human-review coverage, capacity, and human reason coverage; the platform owns the paired model release.

The release suite covers both fixed questions, two successful generated questions, fallback in either or both generated slots, invalid/refused/timed-out model output, grounding rejection, answer revision and regeneration, queue delay, competing deadline settlement, late completion, and publication while participants are active. A referenced evaluation-suite version is audit metadata; the application must not claim that publication ran an external suite unless the release record proves it.

Admission publication treats the human policy and its model as one release. Human review remains available when the configured provider later fails.

### `reviewRounds`

- `eventId`, stable key, sequence, and name;
- `status: draft | published | open | closing | closed`;
- immutable `clockInOpensAt`, `reviewerReportAt`, `noShowGraceSeconds`, scheduled start/end times, and `correctionRequestsCloseAt`;
- review duration and ordinary-extension policy;
- missed-call, queue re-entry, substitute-response, panel-size, scorer, participant-presence, reviewer-build, camera, and notification requirements;
- pinned rubric-version ID and configuration checksum;
- optimistic `version` and created/published/opened times;
- optional closing actor/time and `activeCloseSnapshotId`/`activeRoundExportId`;
- optional closed actor/time.

A round in `closing` points to exactly one normalized snapshot and active export. A closed round keeps those pointers to a verified export and cannot change without the independent reopen command. Reopen clears only the active pointers; the snapshot, entries, export manifest, exact object versions, and audit history remain.

Publication requires `clockInOpensAt <= reviewerReportAt <= startsAt < endsAt`, bounds the no-show grace, keeps the report-plus-grace boundary at or before round start, and places the correction deadline inclusively within the round. These policy fields participate in the immutable configuration checksum.

### `reviewRoundPauses`

- `eventId`, exact `roundId`, and linked active review-backend `incidentId`;
- `state: active | resolved`;
- pause reason, actor, and time;
- optional resume reason, actor, and time;
- optimistic `version`.

A pause is an incident-control record, not a round lifecycle status. The exact-round `by_round_state` range permits one active pause per round. `by_incident_state` prevents the linked incident from resolving first. Queue placement and already-started review work continue; new team calls, new review starts, and round close do not.

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
- authoritative active-member, VIT-member, and external-member counts maintained with every active-member transition;
- submission-materialization state, current submission-attempt ID, current proposal-version ID, first-submitted time, and exact participant-policy version ID used for submission;
- `version`;
- created/updated time.

### `teamMembers`

- `eventId`, `teamId`, `membershipId`
- `role: lead | member`
- `status: invited | active | left | removed`
- joined/left time and source.

The mutation that adds an active member first queries `by_event_membership_status`, preventing a person from joining two active teams in the same event.

Exactly one active team member has `role: lead`. Ordinary membership and role mutations require server time before the deadline for the team's verified participant class. When an application exists, the same transaction must also refresh its immutable roster and proposal snapshot or reject the team change.

### `teamSubmissionAttempts` and `teamSubmissionMembers`

One durable attempt owns final-submission materialization. A completed synthetic attempt also records each accepted post-submission roster revision. The attempt pins the event, team, draft, requester, authorizing grants, operation fingerprint, source and snapshot versions, participant and admission policies, pagination cursor, processed class and year projections, terminal result, and a bounded failure code and message. Its state is `validating | finalizing | complete | failed`.

`teamSubmissionMembers` stores one immutable row per active member for that attempt: stable ordinal, team-member/membership/person IDs, role and participant class, display/profile fields, verified destination email, and materialization time. Indexed pages by attempt are the roster consumed by applications, offers, notifications, and review projections. No submitted document embeds an operations-configurable roster-sized array.

### `teamInvites`

- `eventId`, `teamId`
- token hash;
- expiry and maximum uses;
- status and use count;
- creator.

### `teamLeadershipTransfers`

- `eventId`, `teamId`;
- from/to active membership IDs;
- expected team version;
- `state: pending | accepted | declined | canceled | expired | stale`;
- requested/decided actor and time, expiry, and client operation ID.

Acceptance checks that both memberships are still active, the expected team version is current, and the applicable deadline has not passed. It then changes the two roles, lead pointer, assignment-sourced team-lead grants, and any current application snapshot atomically. A later membership, lead, or version change makes an old request stale.

### `projectDrafts`

One mutable draft per team.

- `eventId`, `teamId`, and required immutable `intakePolicyVersionId`;
- `stage: opening | follow_up | review | submitted`;
- initial idea;
- optional additional information or links, stored as plain text after the intake questions;
- optional pinned novelty-corpus version ID; optional fingerprint, whole-number score, request ID, and evaluation time for the latest signal that still matches the saved idea;
- freshness-attestation actor/time;
- `version`, last editor, updated time.

`projectDrafts.by_event_intake_policy` supports exact active-pin counts for publication review. The draft receives its intake pin at creation. Its first saved idea also pins the current published novelty corpus when one is available. Every later novelty request names and validates that exact pin. Publication never moves it. Changing the idea clears the copied score. Completion can restore one only when its input fingerprint still matches. Questions and answers live in append-only tables. Later checkpoints use separate `teamCheckpointDrafts` records.

### `intakeWorkingFields`

Short-lived server autosave for one team's current idea or exact follow-up field:

- event, team, field kind, and optional generated-question ID;
- verbatim partial value and the authoritative draft version it is based on;
- small field revision, last writing membership, and update time.

One row exists per team and field. A write checks the exact working-field revision and the committed value that editor started from. A newer global draft version is accepted when this exact committed field is unchanged; a change to the same field conflicts. This prevents a delayed browser request from overwriting a teammate's newer text without turning an unrelated proposal change into a false conflict. These rows are the recovery and collaboration layer only: autosave does not advance intake, regenerate a question, create an application version, or run AI. `Next` commits the displayed value into the authoritative draft and removes the working field. Replacing the initial idea removes all old working fields because the question route changes.

### `intakeAnswerVersions`

Append-only participant-written answers.

- `eventId`, `teamId`, `draftId`;
- stable `promptKey` and optional `generatedQuestionId`;
- answer version number and typed value;
- supersedes answer-version ID when edited;
- written by/time;
- client operation ID;
- status `active | superseded | inactive_for_route`.

The initial idea uses `promptKey: initial_idea`; follow-ups use `introduction_follow_up_1` through `_4`. One active answer exists per draft/prompt and per generated question. Editing creates a new version. Replacing a route marks dependent active answers `inactive_for_route` and never deletes history.

### `intakeGeneratedQuestions`

Immutable model-written follow-ups and their validation outcome.

- `eventId`, `teamId`, `draftId`, ordinal;
- question text, `purposeKey`, and `answerLength: short | medium`;
- exact source answer-version IDs;
- pinned intake-policy-version ID and optional matched published idea-pattern key;
- `source: fixed | model | fallback`;
- `state: active | answered | replaced | stale`;
- deterministic validation result and non-sensitive rejection category;
- interpretation ID and created time.

Only one current question may occupy a draft ordinal. Question text is participant-visible project data and is never copied into job metadata or operational metrics.

### `intakeInterpretations`

Model-produced, non-authoritative drafts.

- `eventId`, `teamId`, `draftId`, and pinned `intakePolicyVersionId`;
- exact input answer-version IDs and input checksum;
- ordinal and `state: running | succeeded | refused | invalid | timed_out | rate_limited | failed | stale | disabled`;
- optional matched abstract idea-pattern key;
- covered purpose keys;
- proposed `nextQuestion { text, purposeKey, answerLength, sourceAnswerVersionIds }` or `null`, plus `stopReason`;
- provider request ID, model ID, latency, and non-sensitive failure category;
- created/completed time.

This record cannot become a participant answer, application decision, route assignment, or score. Raw answer text is not copied into job or error metadata.

The intake Workpool has 32 participant-critical slots. Enqueue also schedules one version-bound 20-second end-to-end deadline. If work is still queued, the deadline writes a terminal `disabled` interpretation for that exact input and advances to review. If provider work is running, it settles it as timed out. Either row prevents late queued work from reopening the question.

### `projectVersions`

Immutable submitted proposal versions.

- `eventId`, `teamId`
- project version number;
- verbatim initial idea, optional additional information or links, and ordered current intake responses `{ questionId, ordinal, question, purposeKey, answerLength, source, answer }`;
- required intake-policy-version ID;
- `fresh_for_event` attestation with exact participant-policy version ID and accepted member/time;
- immutable roster-snapshot ID, snapshot member count, and snapshot lead membership ID;
- final confirmation `{ participantPolicyVersionId, previewedDraftVersion, previewedTeamVersion, confirmedBy, confirmedAt }`;
- exact participant- and admission-policy version IDs;
- optional proposal-revision provenance and optional roster-revision provenance, each pointing to the source project version and actor/time;
- source draft version;
- submitted by/at.

The initial application proposal version is immutable. The current lead can append a revised version before the applicable class deadline. A valid membership or leadership change appends a version with a fresh immutable roster snapshot. Each later version copies unchanged attestation and confirmation facts, records its provenance, and carries the current team and content. It does not edit an earlier version. Repository, Figma, demo, and later checkpoint state remain in separate team-scoped records and evidence snapshots.

### `projectCheckpointPlanVersions` and `projectCheckpointDefinitions`

Immutable operations configuration for later team updates.

- the plan stores `eventId`, version, `draft | published | superseded | retired`, checksum, author, and creation/publication time;
- exactly three child definitions use stable keys `ideation`, `intermediate_update`, and `final_update` in canonical order;
- each child stores its matching event-phase key, participant-visible name, first question, short reflection, grace minutes, status, and creation time;
- `events.publishedProjectCheckpointPlanId` changes only the default for a checkpoint that a team has not started;
- publication requires a complete published phase schedule but does not copy its times into the plan. Runtime uses the current published schedule, so a valid schedule extension reaches teams without rewriting their pinned question wording.

### `teamCheckpointDrafts`

One realtime shared draft per team/checkpoint key.

- `eventId`, `teamId`, pinned plan/definition IDs, and checkpoint key;
- `stage: update | follow_up | review | submitted`;
- current update and reflection answer;
- immutable submission ID after final submit;
- optimistic version, last editing membership, and update time.

Every write requires exact-team `team.project.write`, the current version, an admitted team state, and a currently open or grace-period window. A changed first answer clears the dependent reflection. Stable client operation IDs make ambiguous retries return the accepted draft instead of applying twice.

### `teamCheckpointSubmissions`

One immutable submission per team/checkpoint key.

- event/team, pinned plan/definition, current phase-schedule version, and phase-window IDs;
- checkpoint key/sequence and snapshots of the displayed name and both questions;
- both participant answers;
- due/close times and `on_time | late` timing;
- prior submitted checkpoint ID when one exists;
- source draft version, submitting membership, and submission time.

No participant command derives queue or review readiness from this row. Missing and late are observable facts only. `reviewEvidenceCheckpointSets.teamCheckpointSubmissionId` freezes the latest submission at evidence-capture time; reviewer reads and verified round exports resolve that exact ID.

### `applications`

One pre-event application per team/event.

- `eventId`, `teamId`;
- current proposal-version ID;
- admission-policy configuration ID;
- `state: submitted | under_review | accepted | waitlisted | declined | offer_sent | confirmed | offer_expired | withdrawn`;
- current non-canceled assignment count and current-content completed-review count;
- current admission-AI-recommendation ID/state;
- published human decision, reason code, AI disposition `used | cleared | overridden | stale | unavailable`, actor, and time;
- current offer ID;
- application `contentVersion` plus optimistic row `version`.

Any accepted lead revision moves `currentProposalVersionId` to the new immutable version. It increments `contentVersion` and returns the state to `under_review`. It clears invalid decision and AI pointers, supersedes human reviews for older content, and resets current completed review coverage. It leaves earlier proposal, review, and model rows as history.

The aggregate admissions cohort is assembled through bounded internal pages ordered by immutable `submittedAt`. One page hydrates at most 20 applications with their bounded related projections. The public whole-event action requires event-wide `application.read`, applies the caller's separate profile/AI visibility grants to every row, and refuses to cross the 1,500-team applicant release envelope. Mutable state transitions do not reorder the scan.

### `admissionReviewAssignments`

- event/application and reviewer person IDs;
- assigning person and assignment time;
- `state: active | completed | canceled`;
- optimistic version;
- completion time, or cancellation actor/time/reason.

One active assignment exists per application/reviewer. Creation materializes source-attributed exact-application `application.review.read` and `application.review` grants. Completion preserves those grants. Cancellation revokes only that assignment source. This row routes work. It never substitutes for permission checking or human recommendation evidence.

### `admissionHumanReviews`

- event/application and application-content version;
- reviewer person ID;
- recommendation `accept | waitlist | decline`;
- published reason code, optional note, and creation time;
- `status: active | superseded`.

One active recommendation exists per application/reviewer. Replacing a recommendation appends a row and supersedes the prior row. It does not increase the current-content completion count twice. A direct exact review grant can create this evidence without an assignment. Peer recommendations stay out of an assignment-scoped query until the caller submits a current-content recommendation.

### `admissionAIRecommendations`

Immutable, non-authoritative application analysis.

- `eventId`, `applicationId`, `teamId`, current proposal-version ID;
- closed source references `initial_idea | follow_up_1 | follow_up_2` and input checksum;
- admission-policy, experience-band, admission-model-config, instruction, schema, redaction, and evaluation-suite version IDs;
- `state: pending | running | succeeded | refused | invalid | timed_out | rate_limited | failed | stale | disabled`;
- recommendation `accept | waitlist | decline` when succeeded;
- criterion assessments `{ criterionKey, assessment: meets | partly_meets | not_yet_clear, sourceRefs[] }`;
- concise strengths, concerns, confidence, and limitations;
- deterministic validation result, provider request/model/latency/token metadata, and non-sensitive failure category;
- created/completed time.

The input contains the deterministic experience-band key. It does not contain raw year or institution identity fields. It excludes human review and decision state, capacity, attendance, integration statistics, judging material, and scores. A successful row does not update an application decision.

A manual retry never edits this row. `application.ai_recommendation.run` can create a replacement only when this row is the application's current recommendation, the application is `submitted` or `under_review`, and the row state is `refused`, `invalid`, `timed_out`, `rate_limited`, `failed`, or `stale`. The command checks the current application version and recommendation ID. The same transaction inserts the replacement, updates the application pointer/version, and stores one operation receipt and audit event. The old row remains queryable to a caller with read authority. Run authority alone reveals only whether the current row can be retried.

### `admissionOffers`

- `eventId`, `applicationId`, `teamId`;
- exact ordered `offeredTeamMemberIds` copied from the immutable member snapshot and their participant count;
- `source: accepted_decision`;
- sent and expiry time;
- `state: offered | confirmed | declined | expired | revoked`;
- creating person and exact authorizing permission-grant IDs;
- confirmed member IDs when confirmed;
- decision actor/time/reason when terminal;
- `version`.

Sending an offer reserves participant capacity for the deadline-frozen member snapshot in the same mutation. Confirmation verifies the same set for event check-in. It does not create or change team membership. Expiry, decline, or revocation releases the reservation. A scheduled expiry carries the expected offer version. Confirmation or another terminal transition makes the worker a no-op.

### `admissionCapacityBuckets`

- `eventId`, published admission-policy version ID;
- `scope: overall`;
- approved capacity and currently reserved participant count;
- optimistic `version` and updated time.

The overall bucket is required. Human acceptance alone does not change it.

### `admissionCapacityReservations`

- `eventId`, `applicationId`, exact `offerId`, and policy version ID;
- exact participant count;
- `state: active | released`, reserved time;
- release time/reason `offer_declined | offer_expired | offer_revoked` and optional actor.

One application can have only one active reservation. Historical released reservations remain tied to their offers, allowing a corrected later offer without reusing or rewriting the earlier reservation.

### `venueCheckIns`

- `eventId`, `membershipId`, exact `stationId` and `zoneId`;
- identity-check method `vit_id | external_photo_id | approved_exception` and the bounded exception reason only when applicable;
- checked-in actor and time;
- snapshot of the active physical credential ID/kind/version and external printed badge reference when one exists;
- `status: checked_in | reversed`;
- reversal actor/time/reason;
- `version`.

One active venue check-in exists per membership/event. Reversal changes that row to `reversed`, preserves it, and permits a later new row. It proves one staffed arrival decision; credential activation, current venue presence, and attendance-session results remain independent records.

### `venueCheckInCounterShards`

- `eventId`, deterministic participant shard;
- current checked-in count;
- `version`, updated time.

Record and reversal move one participant’s shard in the same transaction as the source row. The event-wide operations projection reads the bounded shard set instead of subscribing to every person row.

## 6. Attendance and presence

### `attendancePlanVersions`

One immutable published plan for session interpretation.

- `eventId`, version number;
- typed session templates, cohort selectors, tracked-zone definitions, accepted credential methods, exception rules, and retention references;
- default check-in/grace/late/away windows;
- `offlineQueueMaxScans` and `offlineQueueMaxAgeSeconds`, validated within 1–25 scans and 30–600 seconds;
- allowed duration/checkpoint result policies;
- optional minimum team-presence rule before a review call/start;
- `status: draft | published | superseded | retired`;
- validation result, checksum, published actor/time.

Publishing validates every zone, method, cohort rule, fallback, accessibility path, station capacity assumption, and retention reference. The owner boundary permits at most 32 zones, 64 sessions, 128 stations, four possibly applicable simultaneous sessions for one participant, and one such required session. Draft creation, publication, and session extension enforce the same limits. A replacement is rejected while a current-plan session is `preparing`, `ready`, `open`, or `closing`; a prepared session must be cancelled and terminalized before replacement. Otherwise the same publication transaction disables the prior plan's stations, revokes their assigned devices and source grants, supersedes the prior plan, and points the event at the new published version.

### `attendanceSessions`

- `eventId`, `planVersionId`, stable key;
- participant-facing name and `kind: hacking | briefing | review_preparation | overnight_access | workshop | other`;
- expected cohort rule;
- `expectationBuildState: not_started | running | complete | failed | canceled` and materialized expectation count;
- tracked zone IDs;
- `requirement: required | optional | information_only`;
- scheduled start, current accepted end, check-in-open, and current late-arrival close;
- actual `openedAt`, fixed `closingCutoffAt`, and terminal `closedAt` or `cancelledAt`;
- away-alert duration;
- result rule and optional minimum team-presence rule before a review call/start;
- `status: scheduled | preparing | ready | open | closing | closed | canceled`;
- active expectation/finalization job references;
- cancellation actor/reason when requested;
- `version`, created time, and last updated time.

Extension adds a validated whole-minute duration to the accepted end and late-arrival close before the prior end; close and cancellation fix the cutoff to `min(server time, accepted end)`. Each command checks and changes the session operational version. Cancellation uses the ordinary `closing` in-progress boundary with a `cancel_results` job, then becomes `canceled`; it resolves materialized participant results as `not_expected` and never edits a presence event.

### `attendanceExpectations`

One participant’s expected relationship to one session.

- `eventId`, `sessionId`, `membershipId`;
- `expectation: required | optional | not_expected | excused`;
- source cohort/snapshot and reason code where exceptional;
- effective time, actor, and `version`.

The expectation set is frozen when the session opens. Later changes are explicit participant exceptions rather than an implicit cohort re-query.

### `attendanceSessionJobs`

Resumable internal batch work for one session.

- `eventId`, `sessionId`;
- `kind: build_expectations | finalize_results | cancel_results`;
- cursor plus scanned and affected counts;
- `status: queued | running | complete | failed | canceled`;
- optional failure code;
- requested actor/operation and created/updated/completed times.

Expectation building runs before session open. Ordinary finalization moves a session from `closing` to `closed`; cancellation finalization moves it from `closing` to `canceled` with no absence result. Canceling while expectation materialization is running first marks that job `canceled`, so a delayed batch cannot recreate work across the session transition. Jobs never call an external provider.

### `attendanceCredentials`

- `eventId`, `membershipId`;
- `kind: vit_id_barcode | badge_qr` and event-scoped `lookupHash`;
- optional barcode symbology/normalization version or external badge reference;
- `state: pending_verification | active | suspended | revoked | replaced` and monotonic `version`;
- enrollment actor/time and optional verification time;
- for any pending physical credential, a five-minute verification expiry; a replacement also records the prior credential ID and reason;
- for a completed replacement, successor credential ID on the old row and predecessor credential ID on the new row;
- revoking/replacing actor, time, and reason on the retired row.

For a VIT ID, the lookup fingerprint is `HMAC-SHA-256(event lookup key, canonical(barcode-profile key, normalized decoded value))`. It is a pseudonymous lookup value, not a biometric. The raw barcode value is never stored. For an external printed QR, the server derives the lookup value from a random 32-byte base64url bearer and stores only that HMAC plus the non-secret short printed reference. A badge bearer or printed reference used by any prior credential row is never rebound. One active lookup fingerprint maps to one event membership, and one active credential of each applicable kind exists per membership.

Initial VIT enrollment begins by decoding the registration number from the participant's physical VIT ID on a provisioned current-plan phone. The server resolves that exact number to one eligible, accepted VIT membership, returns the participant's name and registration number for visible comparison, and stores only the event-keyed barcode fingerprint after the operator confirms the match. No participant QR is involved. The resolution's unused credential slot is claimed by the enrollment under the same operator/phone/station/member. An ordinary enrollment requires `attendance.credential.enrol` for that station and refuses a membership with an active, suspended, or already-pending VIT binding. Rebinding instead requires `attendance.credential.rebind` for the participant's exact person, a current scoped authorization, the current active-or-suspended credential/version, a visible identity confirmation, and a reason. The first different-card scan creates only an expiring pending row. The second matching scan changes the old row to `replaced` and the new row to `active` in one transaction. An active old card remains usable until that transaction commits; a suspended old card remains unusable. The pending fingerprint is never accepted for attendance. An expiry job can revoke only the unchanged pending version, so it cannot undo a verified replacement.

VIT suspension is a separate exact-person transition under `attendance.credential.suspend`, not part of station enrollment or an implicit rebind. It requires the same fresh unused credential-resolution slot, participant-first identity, current-plan phone, station-read access, visible identity confirmation, recent Google session, reason, and active credential/version. One mutation claims that slot, changes `active` to `suspended`, increments the version, and revokes every pending VIT successor that points to that credential. There is no `suspended → active` command. A later recovery must use `attendance.credential.rebind` and a different card; the resolver continues to treat the suspended row as current so station-level enrollment cannot bypass that boundary.

External-badge setup is an optional operational credential flow with three independent exact-person permissions: `attendance.badge.issue`, `attendance.badge.replace`, and `attendance.badge.revoke`. It is distinct from the personal external event pass sent after acceptance. Each begin/revoke claims the unused credential slot for its exact action and credential; a two-scan issue/replacement can finish only against that claim from the same operator/phone/station/member. The operator also needs `attendance.station.read` on the assigned current-plan phone; that station grant confers no badge action. Issue and replacement require visible identity confirmation and a current scoped authorization. The first badge scan inserts only a pending row, returns the derived short reference for comparison with the physical card, and schedules version-checked expiry. The matching second scan activates an issue or atomically marks the old row `replaced` and the successor `active`. Replacement additionally checks the current old credential/version and a reason. Revocation checks its own permission, current version, identity confirmation, current authorization, and reason, then claims the resolution slot and retires the active badge plus any pending successor in one transaction. Raw bearers exist only inside the action that HMACs them; they never enter a mutation argument visible to clients, table, audit summary, operation record, export, or log.

The same participant-first resolution supports staffed venue arrival without coupling it to credential mutation. A VIT participant is resolved directly from the registration number decoded from their VIT ID; an external participant is resolved from their static personal event pass and then has their physical photo-ID barcode linked after a visible identity comparison. A staffed manual fallback resolves a VIT registration number or a verified external email when a barcode cannot be scanned. Each path requires the assigned phone's exact-station read grant and returns the confirmed member/team/class, minimum identity fields, physical-credential state, latest venue check-in, and independent action flags. It also returns an opaque two-minute resolution ID bound to that operator, phone, station, and member. `attendance.venue_check_in.record` checks that unused resolution, the exact person, current provisioned `venue_entry` station, visible class-appropriate ID match, and stable operation ID. `.override_identity` replaces only that normal identity method and additionally requires a current scoped authorization and reason. `.reverse` requires a separate unused resolution, the active row/version, current authorization, and reason. Each successful arrival action consumes the resolution's venue-action slot in the same transaction. A direct membership-ID call or second action cannot bypass a new participant resolution. Record inserts one new row and increments one deterministic aggregate shard. Reversal marks that row and decrements the same shard. When all members of the deadline-frozen roster have current rows, a `confirmed` team advances to `checked_in`. Reversal returns that coarse milestone to `confirmed`, but never rewinds an already `active` team. Review call/start eligibility never trusts that coarse milestone. It reads the active roster and each member's current venue-presence projection. None of the staffed-arrival mutations calls the presence-transition engine.

### `attendanceBarcodeKeySets`

- `eventId`, monotonic key-set version;
- random event lookup key encrypted with authenticated encryption under the server-held attendance wrapping key;
- wrapping-key version and authenticated-encryption nonce/tag;
- `status: staged | active | retired | compromised`;
- created/activated/retired actor, time, and reason.

The table is server-only and has no client query. The event lookup key becomes immutable when the first VIT ID barcode is enrolled or external pass is issued. Rotating the environment-held wrapping key re-encrypts the event key without changing stored fingerprints. If an event lookup key itself is compromised, operations pauses affected credential acceptance, activates a new key set, and requires controlled re-enrollment or pass reissue; raw barcode values cannot be reconstructed or migrated.

### `attendanceExternalPasses`

Static personal event-pass state for accepted external participants only.

- `eventId`, `membershipId`, monotonic version, issued/updated times, and `state: active | suspended`;
- encrypted random bearer plus authenticated-encryption nonce/tag;
- event-keyed lookup hash used by scanners.

One external membership has one persistent pass. Repeated email delivery, portal reads, and wallet generation return the same pass instead of rotating it. The raw bearer is encrypted under the event lookup key and is never stored in plaintext or logged. The QR contains no participant identity data. The participant receives it in the dedicated event-pass email and may save the signed equivalent to Google Wallet or Apple Wallet. A scanner hashes the presented bearer, resolves only one active accepted external membership, and leaves the pass reusable for later presence scans.

### `attendanceExternalIdentityBindings`

First-arrival proof that one external participant's physical photo-ID barcode was compared with their resolved event pass.

- `eventId`, `membershipId`, event-keyed lookup hash, barcode symbology, version, and `state: active | suspended`;
- linking operator and linked/updated times.

The raw physical-ID barcode is never stored. The first external check-in resolves the event pass, displays the participant identity, then links the scanned physical ID only after the operator confirms the visible match. A different active member cannot claim the same fingerprint, and a member cannot silently replace an existing binding.

### `staffedParticipantResolutions`

Short-lived server proof that one staffed phone resolved one participant.

- event, membership, resolution method (`vit_id_barcode | external_pass | manual_lookup`), station, and device-installation IDs;
- optional event-keyed barcode hash and symbology for a VIT-ID resolution;
- resolving person and time;
- two-minute expiry;
- optional venue action `record_check_in | reverse_check_in`, action time, and resulting venue-check-in ID.
- optional credential action `begin_vit_enrolment | begin_vit_rebind | suspend_vit | begin_badge_issue | begin_badge_replacement | revoke_badge | link_external_id`, action time, and exact attendance-credential ID when applicable.

Each successful scan or manual lookup creates a new resolution. Venue and credential actions have independent one-action slots, allowing a desk to perform one legitimate action in each domain without conflating them. A venue action accepts only an unexpired row whose event, member, station, assigned phone, and current operator all match, then fills its slot atomically with the domain write. A credential begin/single-step action does the same with the credential slot; its matching verification checks the claimed action and credential under the same context and remains bounded by the pending credential's five-minute expiry. A reused or mismatched slot fails. The resolution grants no presence, session, roll-call, or other authority.

### `attendanceDeviceInstallations`

- `eventId`, random local installation ID, hashed installation secret, device name, and `android | ios` platform;
- registering person and time;
- latest committed scanner sequence and authenticated heartbeat time;
- current `pendingReplayCount` and optional `oldestPendingCapturedAt`, reported without credential payload;
- `status: active | revoked` and optional revocation time.

The plaintext installation secret remains in device-secure storage. Every protected scanner action hashes it before the internal mutation compares it with the active device row. Heartbeat validates the pending count against the current plan and the oldest capture against its short recovery window, with only a small reporting tolerance for clock/network transit. Aggregate health counts active assigned phones with pending replay and uses the oldest reported capture as signal age.

### `attendanceStations`

- `eventId`, `planVersionId`, zone ID, and optional session ID;
- stable key and participant-facing name;
- `mode: venue_entry | venue_exit | session_confirm | zone_entry | zone_exit | roving`;
- allowed credential kinds and optional validity window;
- optional active device-installation ID;
- `status: inactive | active | disabled`;
- monotonic `configurationVersion`, creation time, and update time.

Only an active station owns a device. Registration moves one current-plan `inactive` station to `active`, attaches one newly registered phone, and creates the operator's source-attributed station grant group in the same transaction. Disable revokes the phone, removes the assignment, changes the station to `disabled`, increments its configuration version, and revokes that source group. Making the station available changes `disabled` to `inactive` with another version increment and does not revive the prior device or grants.

The device submits the expected station version. Scan, enrollment, and heartbeat additionally require the station's plan to equal the event's current published plan. A stale, disabled, detached, revoked, or superseded-plan assignment cannot select a direction or session or write a heartbeat.

### `presenceEvents`

Append-only server-evaluated presence ledger shared by scanner attempts and staff reconciliation.

- `eventId`, optional `sessionId` and `membershipId`;
- `sourceKind: scanner | staff_reconciliation` and the operator;
- scanner-only station/configuration, device, device sequence, and optional resolved credential references;
- client operation ID, effective/captured time, and server-received time;
- scanner transition or `manual_reconcile`;
- `outcome: accepted | duplicate | rejected | needs_review | reconciled`;
- outcome code, correction kind, operator reason, linked participant-projection version, and related source event ID when one exists;
- previous and resulting venue/session state when accepted or reconciled;
- optional manual-sheet/support/incident reference.

Bearer values and hashes are not copied into the event. Accepted events are never edited. Scanner request identity covers every semantic input but not the online/replay transport marker, so an uncertain online send can retry the same persisted operation without creating another receipt. Valid replay uses captured time for transition-window and interval evaluation; received time remains visible. If that accepted transition does not have an effective time strictly after the projection's latest evidence, the event is stored as `needs_review` and the newer projection, interval, counters, and roll-call state remain unchanged. A missing transition links the exact participant version and latest event when available. Voiding an incorrect scan links that latest accepted scanner event explicitly. The deployed live command accepts only an open session; post-session result remedies remain separate.

### `presenceIntervals`

- `eventId`, `sessionId`, `membershipId`, zone ID;
- opening and closing presence-event IDs;
- effective opened/closed time;
- optional voiding and last-reconciliation event IDs/times;
- `status: open | closed | voided`.

One open interval exists per participant/session/tracked zone. Duplicate scans cannot create another. A reversal may reopen the one interval closed by the latest incorrect exit or mark the interval opened by the latest incorrect entry `voided`; finalization ignores voided intervals while the source and reconciliation events remain immutable.

### `participantPresence`

One current projection per participant/event.

- `eventId`, `membershipId`;
- `venueState: not_arrived | inside | temporarily_out | departed | unknown`;
- current zone;
- latest accepted event and server time;
- away-since time;
- `confidence: confirmed | needs_review`;
- current team ID for indexed operational grouping;
- `version`.

### `attendanceTeamAvailability`

One operational projection per confirmed locked team.

- `eventId`, `teamId`;
- frozen active-member count from the confirmed offer roster;
- current inside-member count;
- monotonic `version` and update time.

Confirmation inserts the zeroed row in the offer transaction. An accepted venue entry or exit moves its inside count in the same mutation as the member's venue projection. The deadline-frozen roster makes the active count stable. Review-board, call, start, and waiver paths read this row; it is a derived attendance projection, not team-authored data or a judging fact.

### `sessionAttendance`

One derived result per participant/session.

- `eventId`, `sessionId`, `membershipId`, expectation ID;
- `currentState: not_expected | confirmation_due | present | temporarily_out | complete | excused | needs_review`;
- first confirmation/entry and latest exit/return;
- total present and away duration;
- interval/checkpoint count;
- `arrival: pending | on_time | late | excused | unknown`;
- no result while active; after finalization `result: attended | absent | partial | excused | not_expected | needs_review`;
- result-rule/session version used;
- operational flags and `version`.

Recalculation changes this projection only. It never rewrites the events or intervals used to derive it. One participant/session owns at most 64 presence intervals. The shared transition boundary sends another entry to review, reconciliation refuses another insertion, and terminalization fails visibly on a pre-existing excess instead of issuing an unbounded read.

Venue state is stored once in `participantPresence`. Every applicable or overlapping attendance session has its own `sessionAttendance` row.

### `attendanceParticipantCurrentSessions`

One required participant-facing projection per nonterminal prepared session assignment.

- event, published attendance-plan version, attendance session, source `sessionAttendance` row, and participant membership;
- copied session start for the membership/plan/start index;
- creation time.

Expectation building inserts the source row and projection together. A projection never stores credentials or participant profile data. Open, close, and cancel require the projection set to equal the prepared source set. Finalization and cancellation validate and delete each projection with its source transition. The participant live query reads this table for the published plan and returns all current rows plus the earliest upcoming row. Closed results stay on the source table and load only through explicit newest-first pagination.

### `attendanceResultRemedyCases`

Append-only review of one finalized participant/session result.

- event, attendance-session, membership, and exact `sessionAttendance` row;
- `state: open | approved | declined`;
- opening actor and `openedByKind: participant | staff`;
- participant-safe issue description;
- frozen session version plus original participant-result version, result, present duration, confirmation time, late flag, and latest evidence-event ID;
- resolution actor/time, restricted internal reason, and separate participant-facing note;
- approved replacement result, present duration, confirmation time, late flag, and applied participant-result version when approved;
- case `version`, created time, and updated time.

Only a fully finalized closed session can receive a case, and one participant/session can have at most one open case. A later case may be opened after the prior one is resolved. Approval changes only the derived `sessionAttendance` row and the affected counter shard. It does not insert, edit, void, or delete a presence event or interval.

### `presenceCounterShards`

- `eventId`, `sessionId`, optional zone/team ID;
- state key and deterministic shard number;
- count and `version`.

The participant membership ID selects one of a fixed number of shards. A scan moves one participant between state shards in the same mutation as the individual projection. The attendance board sums the small shard set instead of contending on one event-wide counter or scanning every event.

### `attendanceRollCalls`

- `eventId`, required prepared attendance-session ID and its zone ID;
- `kind: incident | drill`, short name, and start reason;
- `state: active | closed`;
- frozen session version, expected count, snapshot server time, checksum, and starting counts;
- starting actor and time;
- optional closing actor/time/reason and frozen final counts;
- optimistic `version` and updated time.

The prepared session’s `sessionAttendance` rows are the frozen participant set; roll call does not copy another directory. Starting counts classify that set as `not_arrived | inside | temporarily_out | departed | elsewhere | unknown`. One zone has at most one active roll call. The starting snapshot remains stable while live counters continue to change.

### `attendanceRollCallCounterShards`

- event and roll-call IDs plus deterministic membership shard;
- expected, not-arrived, inside, temporarily-out, departed, elsewhere, and unknown counts;
- `version` and update time.

Start creates only the non-empty fixed shards. Every count is non-negative and the six state counts equal `expected`. An accepted venue scan moves one expected participant between states in its deterministic shard in the same transaction as ordinary venue presence. Closing stores the shard sum as final counts and removes the roll call from the active-scan update path.

### `attendanceExports`

- event, exact prepared attendance-session ID and requested session version, and requesting person ID;
- normalized purpose and ordered allowlisted column keys;
- `status: pending | ready | failed`, server-derived expiry from the requester-selected lifetime, work ID, and optimistic `version`;
- one-query snapshot time and row count;
- opaque private-S3 object key, approved region/bucket, byte count, and SHA-256 when ready;
- requested/completed/failed times and a non-sensitive failure category.

There is no exported-row table and no paginated snapshot assembler. The client sends a relative lifetime, never its wall-clock expiry; the request mutation derives `expiresAt` from server time. Generation reads the exact session cohort and the selected identity/profile fields in one consistent query, capped at 1,200 rows, then writes a formula-safe CSV through the bounded export worker. Query responses never expose the storage location. A requester-owned ready record yields a signed URL bounded to the earlier of 60 seconds or export expiry only after exact-session permission, current authorization, expiry, export-version, and checksum checks run again and the download is audited.

### `emergencyPacks`

- event and requesting person IDs, normalized purpose, requested time, and four-hour expiry;
- collision-checked 16-character hexadecimal serial prefix plus zero-to-20 requested spare attendance and review sheets;
- `status: pending | ready | failed`, Workpool ID, failure category/times, optimistic `version`, and derived `expired` read state;
- one logical snapshot time and SHA-256 plus participant, represented-team, station, active-session, current-round, panel, attendance-sheet, and review-sheet counts;
- opaque private-S3 key, exact object-version ID, approved region/bucket, byte count, document SHA-256, and completion time when ready.

The generated roster comes only from participant memberships whose onboarding state is `accepted`; applicants do not become an incident contact export. One internal query reads the accepted profile, active team, last accepted venue state, full published station set, current attendance sessions, and current round/panel/rubric plan. It rejects more than 1,200 accepted participants, 400 represented teams, 100 stations, ten current rounds, or 400 current panels rather than truncating them. The fixed HTML contains prefilled uniquely numbered forms plus requested spares and at least one attendance/review form of each kind.

The source snapshot and generated bytes have separate checksums. Generation writes and immediately reads back the exact KMS-encrypted S3 object version before setting `ready`. Pack history never returns the HTML, roster, storage location, serial prefix, or URL. A print action independently rechecks the ready/unexpired record, event-scoped print grant, Google session age, version, and both checksums before returning an audited exact-version signed URL lasting no more than 60 seconds or the remaining pack lifetime. Pack state has no manual-mode flag.

## 7. Review setup

### `reviewerProfiles`

- `eventId`, `personId`
- domain tags;
- criterion keys;
- languages;
- reviewer type for staffing;
- training state;
- current operational state.

Training and qualification belong to the profile; availability belongs to the round confirmation. The form's constrained hour selections are not imported.

### Reviewer pool and confirmations

`reviewerPoolEntries` stores the latest imported declaration per event/email: seniority, domain, skills, resume link, and GitHub reference. It is source material for profile preparation, not a qualification or attendance record.

`reviewConfirmationRequests` stores one round's scheduled opening, lifecycle, and version. Publication schedules the opening and closure. Ops can reschedule before reviewers can respond; stale jobs read current state before opening or sending notifications.

`reviewerRoundConfirmations` stores one person's pending, confirmed, or unavailable response per round, with canonical time windows, response time, and optimistic version. Clock-in and assignment eligibility require confirmed coverage for the complete next review.

`reviewConfirmationNotifications` records provider delivery separately from the person's response, with bounded attempts, a claim lease, attempt ID, device/token fingerprint, and failure state. Lost access or an already-answered request stops further attempts.

### `reviewerConflicts`

- `eventId`, `reviewerPersonId`
- `teamId?`, `organization?`, conflict category;
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

Clock-in accepts the exact published opening boundary using server time, requires current declared availability, and rejects attempts at or after round end. Confirmed no-show requires the report-plus-grace boundary (or a temporarily-unavailable return-plus-grace boundary) and rejects a present reviewer. Both transitions re-read current presence and panel versions transactionally, so concurrent clock-in and no-show commands cannot both commit.

### `panelPlans`

- `eventId`, `roundId`
- version number;
- status `draft | published | superseded`;
- coverage/configuration summary;
- created and published actor/time.

### `panels`

- `eventId`, `roundId`, `panelPlanId`
- label, venue zone;
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

## 8. Live round state

### `teamRoundStates`

At most one operational record per team/round. No row is needed while a team is merely waiting for the review desk. Staff queue placement creates the row directly as `queued`; `unassigned` is retained only when an operational exception requires a new panel choice.

- `eventId`, `roundId`, `teamId`
- `state: unassigned | queued | called | at_table | in_review | completed | held | missed | withdrawn`;
- optional panel;
- `queuedAt`, `calledAt`, call attempts and latest call time;
- completion, hold, missed, and previous-state facts;
- previous panel and last-move time;
- priority, optimistic `version`, updated actor/time.

This record drives participant status and prevents two active routes for one team.

The live queue is indexed directly by panel, state, priority, and `queuedAt`. A panel move patches the same versioned row; it does not create a second queue record.

### `pages`

One reviewer response request.

- `eventId`, `roundId`, `panelId`, seat label;
- target reviewer;
- reason;
- `state: sent | opened | accepted | declined | expired | canceled`;
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

The confirmation command uses a durable client operation ID for the review, reviewer, and registered phone. The QR or fallback code is a replaceable carrier, not part of that semantic operation identity. After a confirmed commit, a retry resolves the first stored receipt before current-token lookup. It cannot insert another presence row or return counts that changed after the first commit.

### `reviewParticipantAvailabilityWaivers`

One immutable participant-availability exception for one review.

- event, round, team, and review-session IDs;
- required participant count and observed currently-inside count;
- authorizing permission-grant IDs;
- granting person, reason, and server creation time.

The call path may create this row only while the team is below the published minimum and the actor holds `review.participant_availability.waive` for that exact team or the event. A post-call command may use an exact-review, exact-team, or event grant while the review is still awaiting presence. Both require current scoped authorization. The row never changes venue presence, attendance results, queue time, or judging values, and a canceled review does not transfer it to a replacement session.

### `reviewCommitments`

- `eventId`, `sessionId`, `teamId`
- ordered commitment items;
- shared findings;
- next checkpoint;
- entered by and confirmed time;
- `version`.

## 9. Scorecards

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
- manual-review-record ID when the submitted copy came from a verified signed paper review;
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

## 10. Operations, incidents, and audit

### `operationsHealthSnapshots`

One current server-owned aggregate-health materialization per event.

- event ID, the exact event version observed during computation, and `ready | stale` state with its deadline;
- one fully validated bounded redacted health snapshot, including server generation time.

The 30-second cron discovers at most two events and rejects a deployment containing more than one. Its action calls one broad bounded internal query, then one narrow `by_event` upsert mutation. An exact retry is a no-op and an older result cannot replace a newer snapshot. Each accepted generation schedules its own 90-second stale marker; the marker compares the expected generation before changing state, so an old deadline cannot expire a newer snapshot. Event bootstrap schedules the initial refresh. Reads return explicit `missing`, `stale`, or `ready` state and never recompute live.

### `operationsAutonomyPolicyVersions`

One complete immutable autonomy policy version for an event.

- event, monotonic version, and `draft | published | superseded | retired` status;
- enabled flag and `observe | recommend` mode;
- schedule cadence plus selected health severities and areas;
- closed read-tool and typed recommendation-kind allowlists;
- escalation severity, accountable owner, and fixed `operations_dashboard` audience;
- checksum, creator, creation time, and optional publication time.

The normalized checksum covers the complete ordered policy. `operations_health` is mandatory so every run refreshes current state. Observe mode has no recommendation kinds. Recommend mode can record only the selected typed proposals, never execute them. The policy contains no model-turn, delegation, read-byte, wall-clock, proposal, or daily cognitive quota.

### `operationsAutonomyStates`

One current scheduler cursor for a published policy.

- event and exact policy version;
- `active | disabled | superseded` lifecycle and next evaluation time;
- exact pending-work count and optional last evaluation, run, signal, and schedule-slot times;
- current semantic signal fingerprint, recurrence cycle, optimistic version, and update time.

The kill switch changes authority immediately. A new publication supersedes the prior state and cancels its active run. Neither transition waits for queued work to be deleted; cancellation and abort delivery are resumable server-owned cleanup.

### `operationsAutonomyInbox`

One immutable semantic work item for a manual request, schedule slot, or qualifying signal episode.

- event, exact policy version, stable operation key, typed trigger, and frozen redacted source/checksum;
- technical next-attempt time and `pending | claimed | canceled` lifecycle;
- creation and update time.

Exact duplicate observations coalesce, but distinct signal states, a cleared-and-recurring condition, every schedule slot, and every idempotent manual request remain separate. The inbox is written independently of whether an executor is busy and is drained fairly across events. Only one run per event policy is executable at a time.

### `operationsAutonomyRuns` and `operationsAutonomyRunCheckpoints`

A run freezes the claimed inbox item's event, policy/checksum, trigger, effect mode, read/recommendation allowlists, source/checksum, and operation key. Admission records the current Flue submission head. Executor identity is unknown until the first signed callback, then fixes agent version and model. Lifecycle is `pending | active | succeeded | no_op | escalated | failed | canceled` with typed failure or effect-authority cancellation provenance.

The one mutable checkpoint owns the monotonic server sequence, public phase, cumulative audit telemetry, observed signal keys, and any one active read reservation. Telemetry reports work performed; it is not a ceiling. A renewable lease is infrastructure supervision only: expiry causes reconciliation or continuation, not cognitive termination.

### `operationsAutonomyOperationReceipts`

One bounded-size receipt per external work authorization, read page, recommendation-evidence chunk, proposal, or callback, uniquely indexed by run plus stable operation ID and by run plus server sequence. The complete response/effect fingerprint is durable, so a lost response can replay after later operations without a second read, evidence append, or proposal. Read receipts bind the exact traversal snapshot, requested/next cursor, row tuples, response bytes, and terminal/page state. This ledger is allowed to grow with a run; each row remains individually bounded and history is paginated.

### `operationsAutonomyReadFactStates`, `operationsAutonomyReadFacts`, and `operationsAutonomyReadTraversals`

Each unbounded actionable source appends a complete redacted fact in the transaction that changes the source. Sources include operations attention, review exceptions, support work, intake and admission jobs, participant deliveries, integration jobs, round exports, Synesthesia operations, incident readiness, and attendance operations. Each event and source owns a monotonic sequence. An update closes the prior fact interval and appends the new version.

Each signal, schedule, or manual inbox row freezes the high-watermark for every allowed source. The run keeps that vector. The vector is part of the source checksum. A traversal returns only fact versions that were effective at the frozen watermark. Later changes cannot alter the traversal.

Operations health, round summaries, and attendance counts are bounded projections. The run captures each projection once as immutable JSON. A page contains complete rows up to the response-byte limit. No autonomy page wraps a capped interactive-copilot query.

### `operationsAutonomyContinuations` and `operationsAutonomyRunSupervision`

Continuation outbox rows bind one run and prior Flue submission head to one stable next work item. The Worker proves the prior submission settled before dispatching the next submission. Callback and recovery races coalesce on that submission head. Accepted continuation delivery advances the run's current head atomically.

Supervision owns renewable liveness, one explicit outbound admission attempt, and durable `abort_pending` delivery. Initial and continuation signatures share a 30-second acceptance window. The attempt persists the signing time before the action leaves Convex; a delayed action must use that exact time and cannot mint fresh authority after revocation. Convex keeps an ambiguous request in flight beyond the signature window, refuses to acknowledge a not-found Flue abort while an ordinary request may still return, and sends another abort after any late acceptance. Correctness does not depend on that finite timer: the Worker stores a durable run-bound cancellation fence even before a Flue instance exists, and both admission paths check it before creating a submission. Authority loss or the operator kill switch terminalizes the Convex run immediately and retries the exact signed Worker abort until its durable intent is recorded. The public lifecycle calls that state `abort_recorded`, not physical Worker settlement. Transient provider, network, or Worker congestion never silently drops a semantic work item.

### `operationsAutonomyRecommendationEvidenceSets`, `operationsAutonomyRecommendationEvidenceChunks`, and `operationsAutonomyRecommendationEvidenceLeaves`

One recommendation evidence set belongs to one run and proposal key. Signed chunks contain one to four canonical citations, an exact page index, the prior page hash, and a terminal flag. Convex grounds every leaf against the same run's completed read-page receipt before appending it, rejects gaps, reordering, duplicates, set reuse, and cross-run or cross-page splicing, and stores the exact receipt for response-loss replay. The terminal append seals the evidence set with its ID, root hash, leaf count, chunk count, and server sequence. A proposal must reference that exact seal; any versioned target must name one leaf identity contained in the sealed set and grounded to the target ID/version. Leaves remain independently cursor-pageable, so the proposal row stays bounded without making later evidence unreachable.

### `operationsIntelligenceBriefs`

One operator-requested bounded operations brief from the aggregate event-health projection.

- event and required requesting person;
- `state: pending | dispatching | accepted | succeeded | failed`;
- required frozen `sourceSnapshot` and SHA-256 `sourceChecksum`, written together before work is enqueued;
- Convex Workpool job ID, optional Flue submission ID, and Worker acceptance time;
- optional validated headline, summary, and no more than three priorities containing severity, title, explanation, copied owner/next action, and cited health-signal keys;
- optional agent version, model ID, and terminal `dispatch_failed | agent_timed_out | model_did_not_publish | callback_rejected` category;
- requested, updated, and completed times plus optimistic version.

The source snapshot contains only the bounded redacted signal projection, not its protected underlying records. A requested brief copies the current materialized pair before enqueue. Missing or stale health prevents new work. The brief ID is the Durable Object identity. The snapshot/checksum pair cannot change. A priority's owner and next action must match one same cited frozen signal, so separate citations cannot be spliced into a new responsibility. Only the first matching callback or timeout settles the row. Later work creates another row rather than rewriting brief history. Scheduled and signal-driven work belongs exclusively to the autonomy inbox and runs above.

### `intelligenceRecommendations` and `intelligenceRecommendationAutonomyObservations`

One signed copilot or autonomy proposal that no agent can execute directly.

- event, stable proposal/effect keys, and discriminated copilot-conversation or autonomy-run/evidence-set provenance;
- closed typed arguments containing the exact target ID and required target version for versioned commands;
- bounded statement, reasoning, citations, agent version, and model;
- `proposed | approved | rejected | superseded` status, optimistic version, and proposal/update times;
- optional deciding person/time, operator feedback, and executed target reference.

The proposal key is unique inside the event. An identical at-least-once delivery returns the original record; different content under the same key conflicts. If a later autonomous run proposes the same still-open semantic effect, it does not create a second human command or lose the later analysis: one append-only observation links that run, its statement/reasoning/model provenance, and its independently sealed evidence set to the existing recommendation. Observation and evidence history are cursor-paginated. There is no product cap on open proposals: pending work is oldest-first and cursor-paginated, while settled history is independently newest-first and cursor-paginated. Copilot citations keep a short interactive freshness policy. Autonomy evidence binds exact completed read operations and traversal snapshots, so a recovered long-running review remains usable; the expected target version is rechecked when the human approves. Approval, rejection, and revision require the ordinary permission of the underlying command. Approval invokes that command as the authenticated human and both layers audit the human actor. No model callback can approve or execute a recommendation.

Flue Durable Object history is the canonical transcript and stream. Convex does not store token deltas, raw tool calls, or a conversation copy. It stores only business records such as a validated brief or recommendation. A deterministic opaque conversation ID scopes recommendation history to one event-access subject without creating a conversation registry row.

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

- `eventId` and collision-checked public support code;
- category, plain description, and `origin: participant | reviewer | staff`;
- reporter person, reporter event-access subject, and verified contact email at creation;
- optional subject person, team, round, review-session, and attendance-session references validated against the same event;
- optional owner person;
- `state: open | investigating | waiting | resolved | closed`;
- write-owned `lastActionAt`, optional `firstResponseAt`, and `awaitingStaffReply` summary;
- optimistic `version`, created/updated time, and optional resolved/closed time.

The case is a diagnostic work record. A linked resource and owner convey no authority. Creation and staff updates are idempotent actor operations; updates compare `version` and append actions in the same transaction.

### `supportCaseActions`

- `eventId`, `supportCaseId`;
- `kind: opened | reporter_reply | public_note | internal_note | state_changed | owner_changed`;
- `visibility: reporter | internal`;
- actor person and optional body;
- optional previous/next state and previous/next owner person;
- created time.

Actions are append-only. Reporter queries exclude `internal`; a staff reader covered by exact-case or event-wide support read may receive both. The opening description remains on the case and opening action so the timeline is self-contained.

### `supportCaseStatShards`

Sixteen deterministic event shards store exact counts by case state plus live unowned, awaiting-staff-reply, and safety counts. Each case always writes its own shard, so simultaneous work on unrelated cases does not serialize through one event row. Case creation, reporter reply, and staff update change the shard in the same transaction as the case and timeline actions. List queries read the fixed shard set and never rebuild totals or reply duty from historical action rows.

### `rehearsalRuns`

One full release rehearsal created from the code-owned current template.

- `eventId`, name, exact template version, and optional scheduled time;
- `state: draft | active | completed | canceled` and optimistic `version`;
- creator and creation/update times;
- optional start actor/time;
- optional completion actor/time and summary;
- optional cancellation actor/time and reason.

The server creates all 62 scenario rows in the same mutation as the run. One event may keep historical runs but may have only one active run. Completion and cancellation are terminal.

### `rehearsalWorkstreamOwners`

- `eventId`, `rehearsalRunId`, and one of the 11 template workstreams;
- active event-account person used for responsibility routing;
- assigning actor/time and optimistic `version`.

One row exists per run/workstream. Assignment writes no permission grant. The owner needs an ordinary exact-run or event grant before any rehearsal query or command succeeds.

### `rehearsalScenarios`

- `eventId`, `rehearsalRunId`, stable template key, sequence, and workstream;
- copied title, expected state, and recovery action;
- `state: pending | running | passed | failed | blocked`;
- optional terminal result summary and last actor;
- optimistic `version`, created/updated time, and optional start/completion time.

The copied template fields remain fixed for the run. Pending may start or receive a direct result. Running may receive a result. A passed, failed, or blocked scenario must first move back to running through a reasoned rerun; an operator cannot replace one terminal result with another.

### `rehearsalScenarioActions`

- `eventId`, run and scenario references;
- `kind: started | passed | failed | blocked | rerun`;
- previous and next scenario states;
- optional note, actor, accepted scenario version, and server time.

Actions are append-only and written in the same transaction as the scenario state. The result note is required for pass, fail, block, and rerun. A plain initial start may omit it.

### `incidents`

- `eventId`, title, summary, severity, and `affectedService: attendance_backend | review_backend`;
- `state: open | monitoring | resolved`;
- `manualModeState: not_requested | pending | approved | closed` and approval count;
- opened/resolved actors and times, resolution reason, optimistic `version`.

An active incident query returns only `open` or `monitoring` records covered by the caller's exact or event-wide `incident.read` grant. A review incident cannot resolve while a linked `reviewRoundPauses` row remains active.

### `incidentManualModeApprovals`

- `eventId`, `incidentId`, approver person ID;
- incident version, reason, and approval time.

The `(incidentId, approvedByPersonId)` index ensures one approval per person. The second distinct approval atomically changes manual mode to approved.

### `attendanceManualSheets`

- `eventId`, approved `incidentId`, open `sessionId`, zone, station, and pinned station-configuration version;
- printed serial, revision, and `session_confirm | zone_entry | zone_exit` transition;
- 1–25 immutable resolved rows with line number, participant reference/kind, membership, captured time, operator initials, and optional correction reason;
- `state: draft | submitted | imported | needs_review | rejected | canceled`;
- entering person/time and submitted time;
- private source storage ID, file name/type/size, and SHA-256;
- verifier/rejector/original-file actors, times, reasons, import counts, optimistic `version`, and update time.

Only rejected/canceled serials can receive a later revision. The source storage ID is unique across sheets. Imported presence events carry `manualSheetId` and line number, so one line cannot be applied twice.

### `manualReviewRecords`

- event, approved review-backend incident, round, existing active review, team, panel, panel version, evidence-checkpoint set, and rubric version;
- frozen round/review versions and one printed serial/revision;
- copied start/end time and service-unavailability reason;
- one entry for each current assignment containing scorecard/reviewer IDs and names, frozen scorecard version, signature confirmation, complete assigned raw ratings/evidence notes, and optional private note;
- optional shared findings and commitments, required when the round requires them;
- `status: draft | submitted | imported | rejected | canceled`;
- first-entry actor/time and submission time;
- private source storage ID, name/type/size, and SHA-256;
- verifier/rejector/original-file actors, times, reasons, optimistic version, and update time;
- resulting evaluation ID and scorecard-version IDs.

Only rejected or canceled serials can receive another revision. One review can have at most one draft/submitted paper record. Saving that record blocks ordinary writes to its scorecards. Import keeps the signed reviewer as `reviewerPersonId`; the verifier remains on the manual record and audit event.

### `roundCloseSnapshots`

- event, round, and frozen rubric-version IDs;
- monotonically increasing close revision;
- frozen round-configuration checksum;
- result, approved-exclusion, and withdrawal counts;
- checksum, creating actor, and time.

The snapshot is immutable. A later reopen/close creates another revision rather than changing it.

### `roundCloseEntries`

One row per team in the snapshot:

- event, round, snapshot, and team IDs;
- `result` payload with selected review/evaluation IDs, evaluation input checksum, frozen criterion aggregates, and total;
- or `excluded` payload with selected review, approved void-case ID, and category;
- or `withdrawn` payload;
- creation time.

There is no generic “missing” result. Close cannot start until every team-round state maps to exactly one explicit entry.

### `roundExports`

- event, round, close-snapshot, revision, and export-format version;
- `state: generating | uploaded | verified | failed | superseded`;
- closing-round version and Workpool job ID;
- exact counts for teams, results, exclusions, withdrawals, selected reviews, scorecards, scorecard versions, correction cases, and paper-review records;
- one JSON and one CSV manifest, each containing opaque object key, exact S3 object-version ID, byte count, and SHA-256, plus fixed bucket/region;
- request, upload, independent verification, failure, and supersede actors/times/reasons as applicable;
- aggregate checksum, optimistic `version`, and update time.

The live round references one active export. Only an uploaded export can be independently verified; only that transaction changes the round to `closed`. Retry reuses the same snapshot/export identity after failure. Reopen marks a verified export `superseded` and preserves its files before clearing the round’s active pointers.

### `auditEvents`

Append-only protected history.

- `eventId`
- actor person, optional role-label snapshot for display, and device;
- authorizing permission key, matching grant IDs, resolved scope, and access version;
- action;
- target type/ID;
- previous and next summary;
- reason;
- incident/support/correction reference;
- server time;
- release ID.

Indexes support event/time and target/time lookup.

## 11. Integration tables

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

One active integration projection exists per event/team/provider. Its GitHub side owns an ordered set of active repository bindings; its Figma side owns a bounded set of active file bindings. The published integration policy sets both caps. A resource-level uniqueness check prevents the same repository or file from being active for two teams in one event unless a caller with `integration.resource.share_override` for both team integrations records the exception and reason.

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

### `figmaOAuthCredentials`

One encrypted OAuth grant per Figma App/Figma user across Code2Create events.

- Figma `user_id_string`;
- Code2Create person who most recently authorized it;
- exact granted scopes;
- encrypted access token and refresh token;
- token issuance/expiry, encryption-key version, and credential version;
- single refresh lease ID/expiry;
- `state: active | revoked | error`;
- authorized, refreshed, and updated time.

A team does not own this credential record. Global uniqueness is deliberate because Figma maintains one current access token per App/user; copying it by event would create refresh races. No client can query this table or receive a token.

### `figmaCredentialConnections`

The event/team junction that permits one team to use a credential without owning it.

- `eventId`, `teamId`, `credentialId`;
- `state: active | revoked`;
- connecting person, connected time, last verified time, and version.

A credential can support several team connections when the same Figma user is authorized to connect those teams' files. Revoking one junction does not revoke the global credential or erase captured team evidence.

### `figmaFileBindings`

- `eventId`, `teamId`, `integrationId`, `authorizationId`;
- file key, optional main-file key, name, URL, editor type, link access, and role;
- latest observed metadata version, last full-content version, provider last-touched time, and server provider-observation time;
- metadata checked, next metadata check, full content captured, independent metadata lease/error, and separate metadata/content provider retry times;
- rate-limit plan/type and `Retry-After` state when observed;
- webhook ID, event type, endpoint version, passcode hash, and webhook state;
- latest artifact-manifest key and preview count.

Each row references both the credential and its active team junction. A team can hold several active file rows up to the published cap. The file key is unique per event unless a shared-resource override is active. Webhook passcodes are compared by hash; the plaintext exists only while the provider webhook is created or rotated.

### `providerEvents`

- `eventId`, provider, integration ID, and external resource ID;
- provider deduplication key;
- event type;
- GitHub installation/repository/ref/before/after fields or Figma webhook/file/version fields;
- verification result;
- provider time, received time, and processed time;
- processing status and failure category.

GitHub uses `X-GitHub-Delivery`. Figma uses a stable hash of webhook ID, event type, file key, provider timestamp, and version ID when supplied. Raw provider payloads are not retained after validation and field extraction.

### `githubTeamMetrics`

One current materialized row per event/team.

- aggregate health and completeness;
- active installation/repository count and complete/incomplete repository count;
- present/missing/unknown required-topic counts and bounded repository-kind counts;
- pushes, additions, deletions, changed files, and aggregated language bytes;
- unique observed commit count, observed overlap count, and `commitIdentityComplete`;
- latest activity, version, and computed time.

Every accepted GitHub connection, binding, sync, and webhook transition rebuilds this row in the owning mutation. Whole-repository reconciliation retains the bounded comparison response's commit SHAs and deduplicates those exact identities across connected repositories. If GitHub's total exceeds the returned identities, or a project-root binding cannot safely attribute the repository-wide commit list, `commitIdentityComplete` is false and the unique count is a lower bound. Additions, deletions, and changed-file counts remain sums of the visible per-repository evidence; they are not cross-repository deduplicated.

### `figmaTeamMetrics`

One current materialized row per event/team.

- aggregate health and completeness;
- active authorization/file count and complete/incomplete file count;
- dirty, webhook, rate-limit, and preview-ready/pending/attention counts;
- selected/available previews;
- pages, frames, components, component sets, styles, nodes, prototype interactions, comments, unresolved comments, and named versions;
- oldest metadata check, latest full capture/activity, version, and computed time.

Every accepted Figma connection, file, metadata-check, full-sync, preview-render, and webhook transition rebuilds this row in the owning mutation. Every visible file must already have its exact current metric row, snapshot, and preview set; missing evidence is an invariant violation rather than a nullable card fallback. The row reports observed provider evidence and completeness only. It does not infer effort, authorship, quality, or judging value.

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

Materialized provider statistics for fast charts.

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
- metric schema version and sanitized summary;
- private S3 artifact-manifest key, object checksum, and preview count when present;
- freshness, completeness, truncation, and error state;
- previous snapshot ID.

Each GitHub snapshot belongs to one repository binding and contains its declared kind/purpose, topic state, tracked/baseline/head SHAs, tree manifest, activity totals, changed-path summary, languages, discontinuities, and completeness. Figma snapshots contain file/version metadata, node and reuse statistics, named versions, comment counts, top-level-node hashes, changed-frame summary, and protected preview/artifact references.

### `integrationArtifacts`

The authorized manifest for a private provider object. It contains event/team/provider and binding ownership, provider resource/version, approved storage region and bucket, opaque object key, content type/encoding, compressed and uncompressed sizes, SHA-256 checksum, lifecycle state, and creation time. It contains no OAuth or installation credential.

The raw Figma document is gzip-compressed before upload and encrypted with the bucket's KMS key in `ap-south-1`. An operations caller needs `integration.artifact.read` for the exact team or integration before receiving a one-minute raw-download URL. After signing, one final mutation rechecks that permission and the exact latest snapshot, artifact ID, storage location, checksum, capture time, and remaining expiry before it audits and releases the URL. An assigned reviewer instead needs `review.evidence.read` for the exact review or checkpoint: the backend may return a one-minute selected-frame URL or read the raw object server-side for bounded layer browsing. Reviewer raw-download, rendered-frame, and comparison URLs receive the same final assignment, grant, pinned-snapshot, exact private manifest, checksum, and expiry recheck and an audit record before delivery. Queries and browser bundles never receive the object key, bucket credential, or provider token.

### `reviewEvidenceCheckpointSets`

One immutable team evidence bundle used by a review or round transition.

- `eventId`, `roundId`, round sequence, `teamId`, and pinned proposal-version ID;
- ordered GitHub entries `{ bindingId, repositoryId, kind, purpose, snapshotId?, stateAtCapture }`;
- ordered Figma entries `{ bindingId, snapshotId?, stateAtCapture }`;
- expected and captured resource counts;
- aggregate completeness;
- latest lower-round-sequence checkpoint-set ID for the same team when one exists;
- created actor/time and manifest checksum.

Every active repository and Figma binding appears even when its snapshot is missing, so an unavailable resource cannot disappear from reviewer context. A review session stores this set’s ID. The previous-set link is selected in the review-start transaction and included in the manifest checksum; webhook and manual provider snapshots between judging rounds cannot change it. Later repository additions, removals, reordering, kind changes, or provider refreshes create another set and never mutate the first.

### `figmaSnapshotActivity`

One immutable activity manifest per full Figma snapshot.

- event, team, file-binding, snapshot, and exact provider-version IDs;
- observed/captured named-version counts and whether pagination/capture was complete;
- observed/captured comment counts and whether capture was complete;
- reply, resolved-root-thread, and unresolved-root-thread counts;
- capture time.

The manifest is created in the same mutation as the raw snapshot and its facts. Count, completeness, and ownership checks prevent a reviewer query from presenting a partial fact set as complete.

### `figmaVersionFacts`

At most 200 named versions observed during one full snapshot, newest first. Each row stores the snapshot/provider version, provider version ID, bounded label and description, truncation flag, provider user ID and bounded handle, provider creation time, and display order. User IDs stay server-side; the reviewer response exposes the handle only inside the fixed evidence boundary.

### `figmaCommentFacts`

At most 400 comments observed during one full snapshot, newest first. Each row stores the snapshot/provider version, comment and optional parent IDs, bounded message and truncation flag, provider user ID and bounded handle, created/resolved time, optional order ID, reaction count, and display order. Figma comments are not requested at a historical file version, so these rows mean “comment state observed at capture time,” not “comments that existed when this provider version was originally saved.”

### `figmaNodeFacts`

One bounded row per selected top-level node in a Figma snapshot.

- `eventId`, `teamId`, file-binding, snapshot, and preview-set IDs;
- provider version, parent page ID/name/order, node ID/name/type/order, and descendant count;
- semantic hash and `new | changed | unchanged | unknown` state against the prior selected snapshot fact;
- optional source dimensions;
- discriminated render value: `pending`, `failed + failureCode`, or `available + private object manifest + PNG dimensions + SHA-256`;
- created and updated time.

The raw node tree remains in compressed private object storage. These rows drive the page/frame browser and changed-screen list without loading the entire document into a Convex query. The ordered selection contains no more than 48 nodes and is balanced across pages; missing facts from an older or truncated selection are `unknown`, not falsely labeled new.

### `figmaPreviewSets`

One immutable-source, asynchronously completed render set per Figma snapshot.

- `eventId`, `teamId`, file-binding, snapshot, and exact provider-version IDs;
- `pending | running | ready | partial | rate_limited | failed`;
- discovered, selected, available, and failed counts plus truncation;
- one render lease ID/expiry, optional provider retry time, and non-sensitive failure code;
- created, updated, and optional completed time.

Snapshot creation, preview-set creation, selected node-fact insertion, and render-job enqueue happen in one Convex mutation. The render action calls Figma and S3 outside that transaction. Completion accepts one result for every selected fact or writes nothing. A stale lease cannot attach results, and an expiry recovery job can reclaim work. `Retry-After` preserves pending facts; a terminal set has no pending fact.

### `externalJobs`

- `eventId`
- kind `intake_interpret | admission_analyse | github_enrich | github_reconcile | figma_metadata | figma_content | figma_render | figma_webhook_repair | artifact_upload | export_upload`;
- deduplication key;
- target reference;
- Workpool name/work ID and priority;
- `state: pending | running | provider_wait | retry | succeeded | failed | canceled`;
- attempt count, next attempt/provider reset, last status/error category;
- created/finished time.

Job payloads reference protected records instead of copying secrets into the job.

### `reviewerPushDeliveries`

Reviewer substitute pages keep native-provider delivery state separately from the page assignment. Key fields include event/page/person/device, purpose, token fingerprint, `unavailable | pending | sending | retry_wait | provider_accepted | failed | superseded`, attempt count, current claim ID/expiry, next attempt, provider message ID/error category, version, and timestamps. The action claims against the current page/device/token tuple, and an expired claim may be recovered without two current workers publishing state. Push attracts attention but never assigns the reviewer; `provider_accepted` is not device delivery or reviewer acknowledgment.

### `outboundCallConsents`

One current consent row exists for each event, person, and call purpose.

- event, person, optional consented E.164 destination, and `purpose: reviewer_substitute_page | participant_event_update`;
- consent-text version and script-policy version;
- `state: granted | revoked`;
- granted or revoked time, optimistic version, and created/updated time.

The idempotent command record and audit event retain the actor, exact self-scoped consent grant, action, and prior/next state without copying the phone number into audit text. Consent does not grant call authority. Reviewer dispatch also requires the page chain's exact `review.substitute.page` authority. Participant RSVP reminders and team review notices are automatic event updates to the team lead's current profile phone; they do not use participant opt-in controls or consent records.

### `outboundCallDeliveries`

One durable call row records one page escalation, duty reminder, RSVP reminder, or team review notice.

- event, source type/ID, recipient person, destination, purpose, locale, script, and script-policy version;
- consent ID/version for reviewer duty calls and the source's authorizing permission-grant IDs;
- `state: unavailable | pending | sending | retry_wait | provider_accepted | queued | initiated | ringing | answered | completed | busy | no_answer | cancelled | failed | ambiguous`;
- stable delivery ID, claim ID/expiry, attempt number, next-attempt time, provider call ID, safe error category, and timestamps.

For reviewer pages, the claim transaction rechecks the active page, no acknowledgement, current consent version and destination, script policy, and every frozen grant. An acknowledgement that commits first makes the claim cancel the delivery. A claim that commits first may still produce the call; the page response remains authoritative and the transport race stays visible. A backend-to-Worker retry uses the same delivery ID and is idempotent. A provider dispatch whose outcome remains uncertain becomes `ambiguous` and is not redialled.

Releasing admission results opens RSVP offers for selected teams. Ops sets the response deadline and optional reminder-call start in the event timezone, and can update unanswered offers after release. The portal separates selection from confirmed attendance; only the locked team lead can confirm or decline. RSVP invitations include the response deadline. External participants receive no admission or RSVP emails or calls (their event-pass delivery remains separate). An admission offer schedules one RSVP reminder at its configured `reminderAt`, before `expiresAt`. The reminder and dispatch transaction both require the same current offer to remain unanswered and unexpired, the locked team lead to remain eligible, the lead's saved phone to match, and the offer sender's exact offer-management authority to remain active. An RSVP confirmation, decline, expiry, or revocation cancels an undispatched reminder. The call directs the lead to confirm or decline in the participant portal; a telephone response does not change the RSVP. Team review calls continue to follow the published queue policy and current queue state.

Participant outing reminders use source type `participant_outing`, the outing request ID, and purpose `participant_event_update`. An accepted exit scan authorizes this automatic reminder only for the exact overdue participant; no operator grant snapshot is involved. A scheduled deadline and a bounded overdue sweep converge on the unique `by_source` delivery. The claim rechecks the current outing, active participant, admission/eligibility, event window and destination before returning `requiredProvider: sarvam`. Returning removes the source and cancels an unclaimed reminder. The delivery retains transport outcomes for ops, without modifying attendance. The outing `by_phase` index bounds sweep pages; event roster subscriptions look up the exact delivery by source.

### `outboundCallProviderEvents`

Append-only provider events contain the provider event ID, delivery ID, supported event type, optional provider call/error IDs, provider time, and received time. The provider event ID is unique. Reuse with different normalized content fails. Monotonic active states do not regress when callbacks arrive out of order, and a terminal result is not replaced by an older active state. No row stores proposal text, reviewer notes, participant data, or scores.

### Expo Updates R2 objects

Update delivery is deliberately outside Convex and contains no participant, reviewer, permission, or event-operation record. Staging and production have different buckets. Each bucket contains:

- `assets/<sha256>`: immutable bytes with matching SHA-256 metadata, content type, byte length, and one-year immutable public cache policy;
- `releases/<releaseId>.json`: one immutable strict release record containing channel, runtime, release time, signed no-update response, and either signed iOS/Android manifests or a signed rollback-to-embedded directive;
- `runtimes/<runtimeVersion>/current.json`: the only mutable pointer, containing one release ID.

Assets and release records use create-if-absent writes; an identical retry is unchanged and different content conflicts. Asset writes are limited to 25 MiB, release records to 10 MiB, and activation bodies to 1 KiB. Public asset reads stream the verified R2 object rather than buffering it in Worker memory. Registration verifies every referenced asset first and rejects a release clock more than five minutes ahead of Worker time. Pointer activation repeats the clock check and requires the ETag observed before export, or absence when seeding a runtime. R2's conditional write makes two concurrent activations converge on one winner. The Expo app checks this service on launch; it does not turn release metadata into a Convex realtime table.

### `participantNotificationDestinations`

One current verified-email destination per event/person/channel.

- `eventId`, `membershipId`, `personId`;
- `channel: verified_email` and the normalized current Google-verified email;
- `status: active | disabled`;
- optional disabled time, staff actor, and non-sensitive reason code;
- `version`, created/updated time.

`by_event_person_channel` makes destination creation or update unique inside the decision transaction. A later decision can find that the person's Google-verified email changed. In that case, it moves the destination to the new exact address and clears a prior disablement. An old delivery retains the address that it targeted.

### `participantNotificationDeliveries`

One append-only provider attempt for one locked team member and published admission or offer-state version.

- `eventId`, `applicationId`, `teamId`, `membershipId`, `personId`, `destinationId`, and the exact `communicationsPolicyVersionId` used for rendering;
- `channel: verified_email`, exact destination email, generic template key `accept | waitlist | decline | offer | offer_confirmed | offer_declined | offer_expired`, and authenticated portal path;
- application version and a root key composed from template/application version/member;
- retry number and optional `supersedesDeliveryId`;
- `state: pending | sending | retry_wait | sent | delivery_delayed | delivered | bounced | failed | suppressed | unknown | superseded`;
- automatic attempt count, current attempt ID, claim expiry, and next-attempt time;
- optional Cloudflare message ID, provider-accepted/last-event/sent/delivered/completed times, deterministic last provider-event ID for equal-time ordering, and non-sensitive provider error code;
- `version`, created/updated time.

Each admission or offer transition creates retry zero for every member of the deadline-frozen application roster after resolving the current published communications policy. A delivery remains current only while its template and application version still match the authoritative application state. It renders from its pinned published-or-superseded policy, including that policy's outbound provider. A manual retry copies the same pin. A later publication cannot silently rewrite queued wording or move queued work between providers. `by_root_retry` proves that a manual source is still latest. `by_application_membership_created` loads one member row without scanning the application. `by_destination_state` suppresses only queued work for one address. `by_provider_message` joins Cloudflare lifecycle events that can race the send response. A structured provider error that proves non-acceptance can enter the bounded automatic retry schedule. A timeout, invalid/contradictory response, or expired lease becomes terminal `unknown` and cannot be reclaimed or sent through another provider. A manual retry creates a new ID/row only from a definite failure. Delivery is transport telemetry. It never proves that the participant read or accepted the decision or offer.

### `participantNotificationProviderEvents`

Append-only verified Cloudflare Email Sending lifecycle-event receipts. SES messages store provider acceptance on the delivery row; SES lifecycle-event ingestion is not part of this table yet.

- fixed provider and Cloudflare event ID;
- provider message ID, normalized recipient, supported internal event type, provider timestamp, destination-disable decision, and optional safe provider error category;
- normalized signed-payload hash, received time, and optional applied time.

`by_provider_event` deduplicates at-least-once callbacks. It rejects a reused Cloudflare event ID with different content. `by_provider_message_time` applies callbacks in provider-time/event-ID order. It also lets an event received before the send response wait for the delivery's provider message ID. The Queue Worker removes sender, subject, raw SMTP response, and bounce/rejection detail before signing. Convex retains no raw provider event, message body, project data, or participant content.

## 12. Synesthesia tables

### `synesthesiaCatalogTracks`

Event, normalized provider and provider track ID, participant display metadata, duration, explicit-content flag, energy tag, search text, `active | disabled` state, version, actors, and timestamps. A provider track is unique inside one event.

### `synesthesiaWindows`

Event, name/kind, start/end, `draft | published | closed` state, request/vote flags, playback-pause state/reason, licensed-source label, automatic-approval flag, per-person and total request limits, duration/explicit/energy policy, version, actors, and publish/close evidence. Voting has no per-person quota; each person can vote once per song.

### `songRequests`

Event/window/catalog references, requester membership/person, immutable provider/display snapshot, optional note, moderation/playback state, vote and open-report counts, `normal | pinned | deferred` queue mode, schedule, public/internal reasons, actors, playback times, version, and timestamps. One catalog track resolves to one request inside a window.

### `songVotes`

Event/window/request, membership/person, `active | removed` state, version, and timestamps. One request/membership index enforces one row.

### `synesthesiaReports`

Event/window/request, reporter membership/person, reason, `open | resolved | dismissed` state, public and optional internal resolution, resolver, version, and timestamps. One request/reporter index enforces one report.

### `synesthesiaPlaybackEvents`

Event/window/request, `started | played | skipped` kind, operator, accepted request version, reason, and server time. This is an append-only acknowledgment ledger, not a provider/audio record.

### `synesthesiaAccessStates`

Event, participant membership/person, `active | suspended` state, reason, actor, version, and change time. Absence means active. This table never changes the event access subject.

### External recovery manifests

Logical backup and restore-rehearsal records live in the private recovery S3 prefix, not in a Convex table that the restore itself could replace.

The backup manifest stores schema version, event, purpose, operator reference, source deployment and release, Convex CLI version, export time, file-storage inclusion, exact archive bucket/key/version/size/SHA-256, and a sorted inventory. Each JSONL entry records path, record count, and a digest over individually canonicalized records; each stored file records path and byte digest. The aggregate digest covers the ordered inventory.

The rehearsal result stores its source manifest/archive, exact staging target, operator/reason/time, the versioned pre-restore staging backup and inventory, post-restore re-export inventory, bounded differences, and `passed | failed`. A passed result requires an exact inventory match. These objects use separate recovery IAM and are unavailable through participant, reviewer, operations, or Convex function queries.

## 13. Required indexes

| Index                                                                          | Purpose                                                                                                        |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `people.by_auth_user`                                                          | Resolve the current person                                                                                     |
| `eventAccessSubjects.by_event_person_status`                                   | Resolve the event security subject and access version                                                          |
| `eventAccessSubjects.by_event_email_status`                                    | Resolve an exact event-linked account without a cross-table scan                                               |
| `eventAccessSubjects.search_event_display_name`                                | Permission-gated event person search                                                                           |
| `eventAccessInvitations.by_event_email_status`                                 | Resolve the one pending invitation shown to an exact verified Google identity                                  |
| `eventAccessInvitations.by_event_status_created`                               | Page open invitations for authorized event operators                                                           |
| `eventMemberships.by_event_person`                                             | Resolve participant access                                                                                     |
| `eventMemberships.by_event_onboarding_status`                                  | Read only the accepted venue cohort for a bounded emergency snapshot                                           |
| `participantEligibilityImports.by_event_batch`                                 | Resume one checksum-pinned participant registration import                                                     |
| `participantEligibilityImports.by_event_status`                                | Resolve active or preparing participant registration imports                                                   |
| `participantEligibilityEntries.by_import_identity`                             | Authorize one exact participant identity in the active import                                                  |
| `participantEligibilityEntries.by_import_class`                                | Verify exact VIT and external import counts before activation                                                  |
| `participantEligibilityEntries.by_event_import`                                | Audit the bounded entries for one event import                                                                 |
| `teamRosterImports.by_event_operation`                                         | Return one idempotent confirmed participant-team import                                                        |
| `teamRosterImports.by_event_created`                                           | Page immutable participant-team import history                                                                 |
| `teamRosterEntries.by_event_email_status`                                      | Resolve an external participant's current team offer                                                           |
| `teamRosterEntries.by_event_vit_registration_status`                           | Resolve a VIT participant's current team offer                                                                 |
| `teamRosterEntries.by_event_team_status`                                       | Resolve accepted members when the listed lead forms the team                                                   |
| `teamRosterEntries.by_event_status`                                            | Count participant-team assignment states                                                                       |
| `teamRosterEntries.by_import_row`                                              | Audit one participant-team import by source row                                                                |
| `teamRosterEntries.by_event_created`                                           | Page participant-team assignment history                                                                       |
| `rosterImports.by_event_operation`                                             | Return one idempotent confirmed CSV import                                                                     |
| `rosterImports.by_event_created`                                               | Page immutable import history                                                                                  |
| `rosterEntries.by_event_email_status`                                          | First staff/reviewer claim                                                                                     |
| `rosterEntries.by_event_created`                                               | Page event-wide roster history                                                                                 |
| `rosterEntries.by_event_status_created`                                        | Bound status-specific operations and expiry inspection                                                         |
| `rosterEntries.by_import_row`                                                  | Expire or audit one bounded import without an event scan                                                       |
| `rosterEntries.by_claimed_person`                                              | Resolve claimed roster provenance for one event-linked person                                                  |
| `eventRoles.by_event_person_status`                                            | Resolve the organizational label; never authorize                                                              |
| `permissionBundles.by_event_key`                                               | Enforce one stable bundle key inside an event                                                                  |
| `permissionBundles.by_event_status_label`                                      | List bounded active bundles visible to an operator                                                             |
| `permissionBundleVersions.by_bundle_status`                                    | Resolve the editable/current version state for one bundle                                                      |
| `permissionBundleVersions.by_bundle_version`                                   | Resolve immutable bundle history by semantic version                                                           |
| `permissionBundleVersions.by_event_status_label`                               | List published or draft versions by event when required                                                        |
| `permissionGrantBatches.by_event_operation`                                    | Resolve the audited batch created by one bundle application                                                    |
| `permissionGrantBatches.by_event_target_created`                               | Inspect one person’s bundle-application history                                                                |
| `permissionGrantBatches.by_event_bundle_version_status_created`                | Page completed source applications for one retired bundle version without scanning event history               |
| `operationResults.by_actor_operation`                                          | Make a client operation ID idempotent for the authenticated actor                                              |
| `operationsHealthSnapshots.by_event`                                           | Read and upsert the event's one current aggregate-health materialization                                       |
| `operationsAutonomyPolicyVersions.by_event_status`                             | Resolve the event's one draft or published autonomy policy without scanning history                            |
| `operationsAutonomyPolicyVersions.by_event_version`                            | Allocate and inspect immutable event policy versions                                                           |
| `operationsAutonomyStates.by_lifecycle_next_evaluation`                        | Read only active scheduler states that are due                                                                 |
| `operationsAutonomyStates.by_event`                                            | Resolve the event's current scheduler state                                                                    |
| `operationsAutonomyStates.by_policy`                                           | Return the runtime state for one published policy                                                              |
| `operationsAutonomyInbox.by_event_operation_key`                               | Deduplicate one exact manual, schedule-slot, or signal-episode work item                                       |
| `operationsAutonomyInbox.by_lifecycle_next_attempt_at`                         | Fairly claim due semantic work without busy events hiding other events                                         |
| `operationsAutonomyRuns.by_event_policy_lifecycle`                             | Enforce one executable run for an event policy and supervise its lifecycle                                     |
| `operationsAutonomyRuns.by_event_created_at`                                   | Cursor-page complete run history newest first                                                                  |
| `operationsAutonomyOperationReceipts.by_run_operation`                         | Replay one exact lost response without repeating its effect                                                    |
| `operationsAutonomyOperationReceipts.by_run_sequence`                          | Preserve the run's authoritative operation order                                                               |
| `operationsAutonomyRecommendationEvidenceSets.by_run_set`                      | Resolve and seal one run-owned recommendation support chain                                                    |
| `operationsAutonomyRecommendationEvidenceSets.by_run_proposal`                 | Prevent one proposal key from silently switching evidence-set identity                                         |
| `operationsAutonomyRecommendationEvidenceChunks.by_run_set_page`               | Enforce one exact ordered page at each support-chain index                                                     |
| `operationsAutonomyRecommendationEvidenceLeaves.by_run_set_ordinal`            | Cursor-page every canonical leaf in one sealed evidence set                                                    |
| `operationsAutonomyRecommendationEvidenceLeaves.by_run_set_identity`           | Ground a target against one exact leaf in its sealed set                                                       |
| `operationsAutonomyContinuations.by_lifecycle_next_attempt`                    | Retry one durable next-submission outbox item after its prior submission settles                               |
| `operationsIntelligenceBriefs.by_event_requested`                              | Return the latest event brief and preserve request history without scanning other events                       |
| `operationsIntelligenceBriefs.by_event_state_updated`                          | Bound diagnostics and recovery to one event and current brief state                                            |
| `intelligenceRecommendations.by_event_proposal`                                | Make at-least-once proposal delivery idempotent and conflicting reuse definitive                               |
| `intelligenceRecommendations.by_event_status_proposed`                         | Cursor-page every pending human decision oldest first and conversation feedback by status/time                 |
| `intelligenceRecommendations.by_event_decided_at`                              | Cursor-page settled recommendation history newest first                                                        |
| `intelligenceRecommendations.by_event_copilot_conversation_proposed`           | Return only one subject-private copilot conversation's feedback history                                        |
| `intelligenceRecommendations.by_event_autonomy_run_proposed`                   | Audit proposals from one exact autonomous run                                                                  |
| `intelligenceRecommendationAutonomyObservations.by_recommendation_observed_at` | Cursor-page every run observation attached to one deduplicated human action                                    |
| `intelligenceRecommendationAutonomyObservations.by_recommendation_run_set`     | Idempotently attach one exact run and sealed evidence set to that action                                       |
| `supportCases.by_event_code`                                                   | Resolve one public support code inside one event and serialize code allocation collisions                      |
| `supportCases.by_event_updated`                                                | Return a bounded event-wide support list newest update first                                                   |
| `supportCases.by_event_state_updated`                                          | Return bounded active, resolved, or closed support queues without a table scan                                 |
| `supportCases.by_event_state_created`                                          | Resolve the exact oldest open support case without sampling by last update time                                |
| `supportCases.by_event_reporter_updated`                                       | Return only the current reporter's newest cases                                                                |
| `supportCases.by_event_owner_state_updated`                                    | Inspect one owner's routed work by state when an owner view is needed                                          |
| `supportCaseActions.by_case_time`                                              | Return one case's ordered append-only timeline                                                                 |
| `supportCaseActions.by_event_time`                                             | Retain and audit support actions inside the event boundary                                                     |
| `supportCaseStatShards.by_event_shard`                                         | Return exact help-desk totals from a fixed write-sharded event projection                                      |
| `permissionGrants.by_event_permission_status`                                  | Resolve a bounded support-owner picker from the exact active manager grant instead of scanning event accounts  |
| `rehearsalRuns.by_event_created`                                               | List recent event rehearsal runs without scanning history                                                      |
| `rehearsalRuns.by_event_state_created`                                         | Enforce one active event run and list state-specific history                                                   |
| `rehearsalWorkstreamOwners.by_run_workstream`                                  | Resolve the one owner for each required workstream                                                             |
| `rehearsalWorkstreamOwners.by_person_run`                                      | Route a person's assigned rehearsal responsibility without granting access                                     |
| `rehearsalScenarios.by_run_sequence`                                           | Return all 62 copied scenarios in stable order and read them for sign-off                                      |
| `rehearsalScenarios.by_run_key`                                                | Resolve one stable template scenario inside a run                                                              |
| `rehearsalScenarios.by_run_state_sequence`                                     | Filter a run by outcome without scanning other runs                                                            |
| `rehearsalScenarios.by_event_workstream_state`                                 | Inspect bounded event/workstream readiness across runs                                                         |
| `rehearsalScenarioActions.by_scenario_time`                                    | Return one scenario's append-only action history                                                               |
| `rehearsalScenarioActions.by_run_time`                                         | Audit accepted actions across one run in time order                                                            |
| `permissionGrants.by_subject_permission_status`                                | Resolve candidate grants for a protected function inside one event access subject                              |
| `permissionGrants.by_subject_permission_status_scope`                          | Resolve one exact scope, or a bounded ordered set of one resource scope type, without reading unrelated grants |
| `permissionGrants.by_subject_permission_status_valid_until`                    | Resolve one current capability bit without loading every scoped grant for that permission                      |
| `permissionGrants.by_subject_permission_status_scope_type_valid_until`         | Resolve a capability restricted to explicit scope kinds without loading scope IDs                              |
| `permissionGrants.by_person_status`                                            | Paginate current or historical grants for one event person                                                     |
| `permissionGrants.by_source`                                                   | Resolve only grants created by one membership, assignment, or resolved bundle source                           |
| `permissionGrants.by_status_valid_from`                                        | Activate a bounded due set of scheduled grants without scanning unrelated history                              |
| `permissionGrants.by_status_valid_until`                                       | Expire a bounded due set of active grants without scanning indefinite grants                                   |
| `permissionGrants.by_grant_batch`                                              | Inspect grant provenance from one application or migration batch                                               |
| `communicationsPolicyVersions.by_event_status`                                 | Resolve the one current communications draft or publication                                                    |
| `communicationsPolicyVersions.by_event_version`                                | Allocate and inspect immutable communications history                                                          |
| `intakePolicyVersions.by_event_status`                                         | Resolve the one published or draft introduction policy                                                         |
| `intakePolicyVersions.by_event_version`                                        | Allocate and inspect immutable policy history                                                                  |
| `noveltyCorpusVersions.by_event_status`                                        | Resolve the event's one draft or published novelty corpus                                                      |
| `noveltyCorpusVersions.by_event_version`                                       | Allocate and inspect immutable corpus history                                                                  |
| `noveltyCorpusEntries.by_corpus_source`                                        | Enforce one curated source key inside a corpus and replace its bounded set                                     |
| `noveltyCorpusEntries.by_corpus_embedding`                                     | Search native 1,536-value vectors inside one pinned corpus                                                     |
| `noveltyTeamIdeas.by_team`                                                     | Replace or invalidate one team's bounded current novelty rows without scanning the event                       |
| `noveltyTeamIdeas.by_event_embedding`                                          | Search current complete-idea vectors inside one event without exposing another team's text                     |
| `noveltyPreviewRequests.by_team_requested`                                     | Inspect one team's recent preview work; rate enforcement lives in the transactional rate-limiter component     |
| `noveltyPreviewRequests.by_team_state_requested`                               | Invalidate one team's running previews in the same transaction as an accepted idea edit                        |
| `noveltyPreviewRequests.by_team_fingerprint_requested`                         | Reuse one recent successful comparison for unchanged team text                                                 |
| `noveltyPreviewRequests.by_team_client_request`                                | Resolve one idempotent participant preview request                                                             |
| `noveltyPreviewRequests.by_event_state_requested`                              | Read bounded aggregate provider health without project text                                                    |
| `admissionModelConfigVersions.by_event_status_version`                         | Resolve the published admission-analysis contract                                                              |
| `teamMembers.by_event_membership_status`                                       | Prevent two active teams                                                                                       |
| `teamMembers.by_team_status_role`                                              | Return the live roster and enforce one active lead                                                             |
| `teamLeadershipTransfers.by_team_state`                                        | Resolve one pending accepted/stale leadership handoff                                                          |
| `projectDrafts.by_event_intake_policy`                                         | Count active participant drafts pinned to one intake policy                                                    |
| `intakeWorkingFields.by_team`                                                  | Load the bounded collaborative working fields for one team                                                     |
| `intakeWorkingFields.by_team_kind_question`                                    | Enforce one autosaved value and revision for one exact idea or follow-up field                                 |
| `intakeAnswerVersions.by_draft_prompt_status`                                  | Resolve one current answer for a draft prompt                                                                  |
| `intakeAnswerVersions.by_generated_question_status`                            | Couple a current answer to its exact immutable question                                                        |
| `intakeGeneratedQuestions.by_draft_ordinal`                                    | Enforce and resume one current follow-up per ordinal                                                           |
| `intakeInterpretations.by_draft_input`                                         | Deduplicate and reject stale model work                                                                        |
| `intakeInterpretations.by_event_state_created`                                 | Bound recent fallback and stalled-running checks for aggregate event health                                    |
| `projectVersions.by_team_version`                                              | Load exact reviewer context                                                                                    |
| `applications.by_event_state`                                                  | Admission queues and capacity                                                                                  |
| `applications.by_event_submitted`                                              | Page the complete admissions cohort in immutable submission order without state-transition cursor gaps         |
| `admissionReviewAssignments.by_application_reviewer_state`                     | Enforce one active routing row per application/reviewer                                                        |
| `admissionReviewAssignments.by_event_reviewer_state_assigned`                  | Page one person's active/completed review work                                                                 |
| `admissionReviewAssignments.by_application_state_assigned`                     | Read assignment coverage and bounded history for one application                                               |
| `admissionHumanReviews.by_application_reviewer_status`                         | Resolve and replace one reviewer's current recommendation                                                      |
| `admissionHumanReviews.by_application_reviewer_content_version`                | Resolve the newest immutable review for one reviewer and application-content version                           |
| `admissionHumanReviews.by_application_status`                                  | Count current recommendations and publish a human decision                                                     |
| `admissionAIRecommendations.by_application_input_checksum`                     | Deduplicate analysis and reject stale application/model work                                                   |
| `admissionAIRecommendations.by_event_state_created`                            | Bound recent unavailable/stalled analysis checks without reading application content                           |
| `admissionOffers.by_event_state_expiry`                                        | Find open offers due for version-checked expiry                                                                |
| `admissionOffers.by_application_sent`                                          | Resolve immutable offer history and the current application pointer                                            |
| `admissionCapacityReservations.by_application_state`                           | Enforce one active exact-roster reservation per application                                                    |
| `admissionCapacityReservations.by_offer`                                       | Prove one offer owns the reservation it confirms or releases                                                   |
| `venueCheckIns.by_event_membership_status`                                     | One staffed arrival record                                                                                     |
| `venueCheckIns.by_membership_time`                                             | Return current and historical arrival decisions for one participant                                            |
| `venueCheckIns.by_event_status_time`                                           | Bound authorized event arrival inspection                                                                      |
| `venueCheckInCounterShards.by_event_shard`                                     | Realtime checked-in aggregate without one write hotspot                                                        |
| `staffedParticipantResolutions.by_event_membership_time`                       | Resolve bounded recent desk context for one participant                                                        |
| `attendanceExternalPasses.by_membership`                                       | Resolve one stable personal event pass for an external participant                                             |
| `attendanceExternalPasses.by_event_lookup`                                     | Resolve an active external pass without storing its bearer in plaintext                                        |
| `attendanceExternalIdentityBindings.by_membership`                             | Resolve one linked physical-ID fingerprint for an external participant                                         |
| `attendanceExternalIdentityBindings.by_event_lookup`                           | Prevent one external physical ID from linking to two event memberships                                         |
| `attendancePlanVersions.by_event_status_version`                               | Resolve the published attendance policy                                                                        |
| `attendanceSessions.by_event_status_start`                                     | Active/upcoming session board                                                                                  |
| `attendanceExpectations.by_session_membership`                                 | Resolve one participant’s session requirement                                                                  |
| `attendanceExpectations.by_session_expectation`                                | Expected/optional/excused lists                                                                                |
| `attendanceSessionParticipants.by_membership_completed`                        | Paginate one participant's finalized attendance results newest first without mounting current state            |
| `attendanceParticipantCurrentSessions.by_membership_plan_start`                | Subscribe one participant to current-plan session state in schedule order                                      |
| `attendanceParticipantCurrentSessions.by_session_membership`                   | Enforce one exact current projection for each prepared session participant                                     |
| `attendanceSessionJobs.by_session_kind`                                        | Resolve expectation and close/cancellation history for one session                                             |
| `attendanceSessionJobs.by_status_updated`                                      | Operate stalled internal work                                                                                  |
| `attendanceSessionJobs.by_event_status_updated`                                | Diagnose bounded event job state without scanning another event or historical parent                           |
| `attendanceBarcodeKeySets.by_event_status_version`                             | Resolve the one active server-only VIT barcode lookup key set                                                  |
| `attendanceCredentials.by_event_lookup`                                        | Resolve an active VIT barcode or external badge without storing the raw value                                  |
| `attendanceCredentials.by_membership_state`                                    | Enforce one current physical method and inspect pending/replaced history for one participant                   |
| `attendanceCredentials.by_event_badge_reference`                               | Find a support-safe printed badge reference without exposing its bearer or hash                                |
| `attendanceStations.by_plan_key`                                               | List the immutable station topology for one attendance-plan version                                            |
| `attendanceStations.by_device_status`                                          | Resolve the one active station attached to a registered scanner phone                                          |
| `attendanceDeviceInstallations.by_event_status`                                | Resolve only active event scanner installations for liveness checks                                            |
| `presenceEvents.by_operator_operation`                                         | Resolve an ambiguous operator retry across scan/reconciliation commands                                        |
| `presenceEvents.by_device_sequence`                                            | Reject scanner sequence reuse and order offline replay                                                         |
| `presenceEvents.by_session_membership_time`                                    | Load one participant's exact session ledger for correction preview                                             |
| `presenceIntervals.by_session_membership`                                      | Load the participant/session interval projection and enforce one open interval transactionally                 |
| `participantPresence.by_event_membership`                                      | Current participant projection                                                                                 |
| `participantPresence.by_event_session_state_zone`                              | Indexed live attendance lists                                                                                  |
| `attendanceTeamAvailability.by_event_team`                                     | Resolve one current locked-team inside count for the review board and review commands                          |
| `sessionAttendance.by_session_membership`                                      | One derived participant result                                                                                 |
| `sessionAttendance.by_session_result`                                          | Session exception/completeness board                                                                           |
| `attendanceResultRemedyCases.by_session_membership_state`                      | Enforce and load the one open finalized-result review                                                          |
| `attendanceResultRemedyCases.by_session_membership_created`                    | Load one participant/session review history newest first                                                       |
| `attendanceResultRemedyCases.by_session_state_created`                         | Operate the exact-session open-review queue                                                                    |
| `attendanceResultRemedyCases.by_membership_created`                            | Return only the caller's own review history                                                                    |
| `presenceCounterShards.by_session_scope_state_shard`                           | Low-contention live counts                                                                                     |
| `attendanceRollCalls.by_event_state_started`                                   | Load active roll calls affected by a venue transition                                                          |
| `attendanceRollCalls.by_zone_state_started`                                    | Enforce one active roll call per zone                                                                          |
| `attendanceRollCalls.by_session_started`                                       | Load exact-session roll-call history                                                                           |
| `attendanceRollCallCounterShards.by_roll_call_shard`                           | Subscribe to bounded live/final roll-call counts                                                               |
| `attendanceExports.by_session_requester_created`                               | Return only the caller's recent exports for one exact session                                                  |
| `attendanceExports.by_event_status_created`                                    | Operate pending/failed export work without exposing files through a broad query                                |
| `emergencyPacks.by_event_created`                                              | Return the newest bounded event pack manifests without reading their contents                                  |
| `emergencyPacks.by_event_serial_prefix`                                        | Reject a second pack with the same printed-form namespace in that event                                        |
| `emergencyPacks.by_event_status_created`                                       | Detect only current failed or stalled generation work through the bounded health projection                    |
| `attendanceManualSheets.by_event_serial_revision`                              | Enforce one active/completed revision of a printed serial                                                      |
| `attendanceManualSheets.by_session_status_created`                             | Block close and operate outstanding sheets for one exact session                                               |
| `attendanceManualSheets.by_incident_status_created`                            | Block incident resolution while paper work is unfinished                                                       |
| `attendanceManualSheets.by_source_storage`                                     | Prevent one immutable source image from backing two sheets                                                     |
| `manualReviewRecords.by_event_serial_revision`                                 | Enforce one active/imported revision of a printed review serial                                                |
| `manualReviewRecords.by_review_status_created`                                 | Freeze ordinary score writes and operate one pending record for an exact review                                |
| `manualReviewRecords.by_round_status_created`                                  | Block round close while paper review work is unfinished                                                        |
| `manualReviewRecords.by_incident_status_created`                               | Block review-incident resolution while paper work is unfinished                                                |
| `manualReviewRecords.by_source_storage`                                        | Prevent one immutable source image from backing two review records                                             |
| `reviewRoundPauses.by_round_state`                                             | Resolve and enforce the one active incident pause for an exact round                                           |
| `reviewRoundPauses.by_incident_state`                                          | Block incident resolution while any linked round remains paused                                                |
| `reviewRoundPauses.by_event_state_paused`                                      | Return bounded active/history rows for event operations and monitoring                                         |
| `reviewerConflicts.by_event_reviewer_team_status`                              | Remove ineligible assignments                                                                                  |
| `reviewerClockIns.by_round_status`                                             | Panel readiness and substitutes                                                                                |
| `reviewerClockIns.by_event_status_heartbeat`                                   | Find stale present reviewers by server heartbeat without reading unrelated rounds                              |
| `panelMembers.by_round_reviewer_status`                                        | Prevent overlapping panel seats                                                                                |
| `reviewPanels.by_event_status_updated`                                         | Surface bounded panels currently missing a reviewer                                                            |
| `teamRoundStates.by_round_team`                                                | One team state per round                                                                                       |
| `teamRoundStates.by_round_state_priority_queued`                               | Unassigned/held/completed operations lists and queue-time ordering                                             |
| `teamRoundStates.by_panel_state_priority_queued`                               | Ordered panel queue                                                                                            |
| `pages.by_reviewer_state_deadline`                                             | Reviewer Now and expiry                                                                                        |
| `reviewerPages.by_event_state_expiry`                                          | Surface sent/opened substitute pages that passed their response deadline                                       |
| `reviewSessions.by_round_team_status`                                          | Prevent duplicate active review                                                                                |
| `reviewSessions.by_panel_status`                                               | One active team per panel                                                                                      |
| `reviewSessions.by_event_status_updated`                                       | Bound overdue-review health checks by event and current state                                                  |
| `reviewPresence.by_session_reviewer`                                           | One scan per assigned reviewer                                                                                 |
| `reviewParticipantAvailabilityWaivers.by_review`                               | Resolve at most one immutable participant-availability exception for a review                                  |
| `scorecards.by_session_reviewer`                                               | One working scorecard per reviewer                                                                             |
| `scorecards.by_round_session`                                                  | Freeze and count selected-round scorecards without scanning another round                                      |
| `scorecardVersions.by_scorecard_version`                                       | Immutable submission history                                                                                   |
| `scorecardVersions.by_round_session`                                           | Export all immutable versions for a selected review                                                            |
| `reviewAssignments.by_round_session`                                           | Revalidate selected-review assignments at export time                                                          |
| `reviewEvaluations.by_round_state`                                             | Resolve complete or void evaluations during round close                                                        |
| `roundExports.by_event_state_updated`                                          | Diagnose bounded export state while parent rounds select the one current revision                              |
| `teamIntegrations.by_event_team_provider`                                      | One shared provider binding per team                                                                           |
| `teamIntegrations.by_event_provider_state`                                     | Operations health board                                                                                        |
| `githubInstallations.by_event_installation`                                    | Resolve an App webhook installation                                                                            |
| `githubStarSetupIntents.by_state_digest`                                       | Claim one participant OAuth callback without storing raw state                                                 |
| `githubStarAuthorizations.by_event_membership`                                 | Load the one temporary GitHub authorization for a participant                                                  |
| `githubStarAuthorizations.by_event_github_user`                                | Prevent one GitHub user from authorizing two participants in an event                                          |
| `githubStarCompletions.by_event_membership`                                    | Enforce the mandatory onboarding boundary for one participant                                                  |
| `githubStarCompletions.by_event_github_user`                                   | Prevent one GitHub user from completing the boundary twice in an event                                         |
| `githubRepositoryBindings.by_event_repository_state`                           | Route a repository event and prevent duplicate use                                                             |
| `githubRepositoryBindings.by_integration_state_order`                          | Ordered active repository set for one team                                                                     |
| `githubRepositoryBindings.by_event_state_sync_updated`                         | Count only current setup/active bindings in an exact sync state and age window                                 |
| `githubRepositoryBindings.by_event_state_sync_lease`                           | Find current running syncs whose lease expired                                                                 |
| `githubRepositoryBindings.by_event_state_topic_updated`                        | Find missing/unknown required topics without including archived bindings                                       |
| `githubTeamMetrics.by_team`                                                    | Load the one current participant/team integration summary                                                      |
| `githubTeamMetrics.by_event_updated`                                           | Page event operations summaries without loading every repository binding                                       |
| `figmaOAuthCredentials.by_figma_user`                                          | One refreshable Figma grant per App/provider user                                                              |
| `figmaCredentialConnections.by_team_credential`                                | Reuse one credential without transferring team ownership                                                       |
| `figmaFileBindings.by_event_file`                                              | Route a webhook and prevent duplicate event use                                                                |
| `figmaFileBindings.by_team_state`                                              | Load every active file for one team                                                                            |
| `figmaFileBindings.by_event_state_sync_updated`                                | Count only active bindings in an exact sync state and age window                                               |
| `figmaFileBindings.by_event_state_sync_lease`                                  | Find active running syncs whose lease expired                                                                  |
| `figmaFileBindings.by_event_state_webhook_updated`                             | Bound active webhook error/pending/unavailable checks                                                          |
| `figmaFileBindings.by_state_metadata_due`                                      | Dispatch a bounded global page of due or not-yet-scheduled metadata checks                                     |
| `figmaFileBindings.by_event_state_metadata_check`                              | Detect stale provider observation for one event without scanning every file                                    |
| `figmaFileBindings.by_event_state_rate_limit`                                  | Find active file requests still inside Figma's exact `Retry-After` window                                      |
| `figmaFileBindings.by_event_state_metadata_rate_limit`                         | Find active Tier 3 metadata checks still inside Figma's exact `Retry-After` window                             |
| `figmaTeamMetrics.by_team`                                                     | Load the one current participant/team design summary                                                           |
| `figmaTeamMetrics.by_event_updated`                                            | Page event operations summaries without loading every Figma file or snapshot                                   |
| `integrationArtifacts.by_object_key`                                           | Resolve one immutable private-object manifest                                                                  |
| `providerEvents.by_provider_dedupe`                                            | Ignore retries/replays                                                                                         |
| `githubCommitFacts.by_binding_sha`                                             | Idempotent per-repository commit enrichment                                                                    |
| `integrationMetricBuckets.by_integration_scope_binding_bucket`                 | Per-resource and team-rollup charts without scans                                                              |
| `integrationSnapshots.by_binding_time`                                         | Compare one resource across checkpoints                                                                        |
| `reviewEvidenceCheckpointSets.by_round_team_time`                              | Resolve immutable evidence for one team and round                                                              |
| `reviewEvidenceCheckpointSets.by_team_round_sequence_created`                  | Link a new review to the latest lower-sequence judging checkpoint                                              |
| `figmaSnapshotActivity.by_snapshot`                                            | Resolve the one immutable activity manifest for a snapshot                                                     |
| `figmaVersionFacts.by_snapshot_order`                                          | Return bounded named versions in captured order                                                                |
| `figmaCommentFacts.by_snapshot_order`                                          | Return bounded comments in captured order                                                                      |
| `figmaPreviewSets.by_snapshot`                                                 | Resolve the one render set for an immutable Figma snapshot                                                     |
| `figmaPreviewSets.by_binding_time`                                             | Show current render health for one connected file                                                              |
| `figmaPreviewSets.by_event_state_updated`                                      | Bound event render-state diagnostics                                                                           |
| `figmaPreviewSets.by_event_state_lease`                                        | Find running render sets whose lease expired                                                                   |
| `figmaNodeFacts.by_preview_page_order`                                         | Return the bounded page/frame browser without loading raw JSON                                                 |
| `figmaNodeFacts.by_preview_node`                                               | Prove one requested frame belongs to the selected render set                                                   |
| `figmaNodeFacts.by_snapshot_page_order`                                        | Load the exact frame facts on either side of a pinned checkpoint comparison                                    |
| `externalJobs.by_state_next_attempt`                                           | Workpool/provider retry diagnostics                                                                            |
| `reviewerPushDeliveries.by_page`                                               | Resolve push transport independently of page acknowledgment                                                    |
| `outboundCallConsents.by_event_person_purpose`                                 | Resolve current consent before a call claim                                                                    |
| `outboundCallDeliveries.by_source`                                             | Resolve the one call delivery for an exact source and purpose                                                  |
| `outboundCallDeliveries.by_target_state`                                       | Show one person's current call-delivery state                                                                  |
| `outboundCallDeliveries.by_event_state_updated`                                | Operate and diagnose current event call deliveries without a scan                                              |
| `outboundCallProviderEvents.by_provider_event`                                 | Deduplicate at-least-once call-provider callbacks                                                              |
| `participantNotificationDestinations.by_event_person_channel`                  | Resolve one current verified-email destination per event person                                                |
| `participantNotificationDeliveries.by_root_retry`                              | Prove a manual retry source is still the latest append-only attempt                                            |
| `participantNotificationDeliveries.by_application_membership_created`          | Show each deadline-frozen roster member's current decision-delivery state                                      |
| `participantNotificationDeliveries.by_destination_state`                       | Suppress queued work for one disabled address without scanning deliveries                                      |
| `participantNotificationDeliveries.by_event_state_updated`                     | Bound current terminal/pending delivery checks by event                                                        |
| `participantNotificationDeliveries.by_event_state_claim`                       | Find sending attempts whose processing claim expired                                                           |
| `participantNotificationDeliveries.by_event_state_next_attempt`                | Find retry-wait attempts whose scheduled retry is overdue                                                      |
| `participantNotificationProviderEvents.by_provider_event`                      | Deduplicate signed at-least-once Cloudflare Email lifecycle events                                             |
| `synesthesiaCatalogTracks.by_event_provider_track`                             | Enforce one provider track per event                                                                           |
| `synesthesiaCatalogTracks.by_event_status_title`                               | Return a bounded active/disabled catalog without scanning requests                                             |
| `synesthesiaCatalogTracks.search_event_catalog`                                | Search active title/artist/album text inside one event                                                         |
| `synesthesiaWindows.by_event_status_start`                                     | Resolve the active published window and reject overlap                                                         |
| `synesthesiaWindows.by_event_start`                                            | Return the event's bounded window history                                                                      |
| `songRequests.by_window_track`                                                 | Resolve concurrent duplicate track requests                                                                    |
| `songRequests.by_window_created`                                               | Return the bounded participant/operations window queue                                                         |
| `songRequests.by_window_state_created`                                         | Enforce one playing request and load state-specific work                                                       |
| `songRequests.by_window_requester_created`                                     | Enforce and display one participant's request limit                                                            |
| `songRequests.by_event_created`                                                | Bound event-level support/history reads                                                                        |
| `songVotes.by_request_member`                                                  | Enforce one vote row per participant/request                                                                   |
| `songVotes.by_window_member_state`                                             | Read one participant's active votes and display their vote count                                               |
| `synesthesiaReports.by_request_reporter`                                       | Enforce one report per participant/request                                                                     |
| `synesthesiaReports.by_request_state_created`                                  | Page one request's report history/state                                                                        |
| `synesthesiaReports.by_window_state_created`                                   | Return bounded open report work for a window                                                                   |
| `synesthesiaReports.by_window_reporter`                                        | Return one participant's report state in the current queue                                                     |
| `synesthesiaPlaybackEvents.by_request_time`                                    | Audit one request's playback acknowledgements                                                                  |
| `synesthesiaPlaybackEvents.by_window_time`                                     | Audit a window's operator playback sequence                                                                    |
| `synesthesiaAccessStates.by_membership`                                        | Resolve the participant's current music-access state                                                           |
| `synesthesiaAccessStates.by_event_state_changed`                               | Operate an event's active/suspended music access                                                               |
| `operationResults.by_actor_operation`                                          | Resolve ambiguous writes                                                                                       |
| `roundCloseSnapshots.by_round_revision`                                        | Immutable close revision history                                                                               |
| `roundCloseEntries.by_snapshot_team`                                           | Page one frozen disposition per team in deterministic order                                                    |
| `roundExports.by_round_revision`                                               | Allocate and inspect immutable export revisions                                                                |
| `roundExports.by_event_state_updated`                                          | Operate failed or in-progress export work without a broad scan                                                 |
| `auditEvents.by_event_time`                                                    | Event audit                                                                                                    |
| `auditEvents.by_target_time`                                                   | Object history                                                                                                 |

“Unique” behavior is enforced by querying the index and writing inside one Convex transaction. Concurrent mutations that read the same index range are retried by Convex.

## 14. Realtime projections

### Surface capabilities and `access.detail`

`access.participantCapabilities`, `access.reviewerCapabilities`, and `access.operationsCapabilities` each return only the fixed server-derived navigation capabilities used by that product surface. A participant session never evaluates the operations or reviewer permission matrix. These projections return no grant IDs, permission-key ledger, source, scope ID, expiry, roster, provider record, person profile, or role label. Each capability uses bounded indexed existence reads, and every later domain function authorizes the exact resource again.

`access.detail` requires `access.permissions.read` for the exact target person or event. It returns that person’s role label, separate effective and current-or-scheduled permission-key projections, the stable catalog, exact target actions, and separate grant/revoke ceilings. `access.grantLedger` separately paginates at most 50 scheduled/current/historical rows at a time, with optional permission/status narrowing; each row resolves its source, exact scope label, validity, materialized lifecycle times, and whether this caller may revoke it. Creating an exact-person delegation accepts one verified event email inside the unrestricted grant command; it does not grant general people search.

### `permissionBundles.workspace` and `permissionBundles.detail`

Return the code-owned permission catalog plus at most 100 active stable bundles covered by the caller's exact `access.permission_bundles.read` grants. Draft contents appear only for a readable exact bundle. Editing requires independent publish coverage for that same bundle; creating a new stable identity requires event-wide read and publish authority. A save checks the stable object's version and current draft revision. Publication checks the same pointers again, requires a current scoped authorization and reason, retires the previous published version, and publishes the draft atomically.

### `permissionBundles.applicableToTarget` and `permissionBundles.previewApplication`

Return only current published bundles for which the caller can read and apply the exact bundle and can read and apply bundles to the exact target person. Preview accepts named resource choices. It then reloads and validates every event-owned resource. It resolves target/self scopes on the server and applies the bounded expiry. It marks grants that another source currently covers. It returns a checksum bound to the published bundle content, resolved grant set, target, expiry, and current target access version. It never returns an unvalidated raw binding as a grant.

### `permissionBundles.apply`

Recomputes the full preview. The command requires a current scoped authorization. It checks the preview checksum and target access version. One Convex mutation writes the grant batch, every missing atomic grant, one target access-version increment, the audit event, and the idempotent operation result. An exact client-operation retry returns the recorded batch result. The command cannot partially apply a bundle or continue after bundle, target, resource, permission, session, or version authority changed.

### `rosters.workspace`, `rosters.list`, and `rosters.mine`

`rosters.workspace` returns event scheduling bounds, import availability, only the current published compatible bundle versions the operator may both read and apply, and exact-row history when the caller lacks event-wide read. `rosters.list` pages event-wide history in creation order. Both derive pending expiry and revoke availability from server time and exact grants; they return no raw provider subject, auth-user ID, or permission contents.

`rosters.mine` is identity-scoped rather than permission-scoped. It returns only one unexpired pending row whose normalized email exactly equals the current verified Google email, plus the pinned bundle labels/versions needed for confirmation. It validates import and bundle provenance before returning. It exposes no other roster row.

`rosters.previewImport` validates the bounded CSV request and resolves row outcomes and selected bundles without writing. `rosters.confirmImport` recomputes that state, checks the preview checksum and current scoped authorization, then stores the import, new rows, superseded rows, expiry schedule, audit event, and operation result atomically. `rosters.claim` and `rosters.revoke` use the current row version and idempotency key; claim requires the matching verified identity, while revoke requires exact-row or event-wide `access.roster.revoke` and current authorization.

### Participant home composition

The web portal composes small subscribed queries for participant/team/project completion, application/admission state, communications, notification delivery, attendance, review-presence QR capability, queue estimate, generic round pause, checkpoints and integrations. It does not use one unbounded participant-home response. The composed view never exposes an internal incident title, summary, or pause reason.

### `participants.me`

Returns the current Google-linked person, optional event membership, saved profile, and current published participant policy after exact-self profile read when a membership exists. The projection computes completeness against the publication and reports whether the membership accepted that exact policy ID. It includes only fields the profile already owns; intake and model functions receive none of them. The separate `participants.acceptPolicy` mutation requires explicit acceptance, the displayed current policy ID, exact-self profile-write permission, and a stable operation ID. It appends that policy ID to the event membership once and records the audit event. Saving a profile requires prior acceptance and includes the displayed policy ID, expected profile version, and a stable operation ID. A publication race, repeated operation, or competing profile save cannot create a partial or duplicate write.

### `participantCommunications.current`

Requires an authenticated event membership, active team membership, and exact-team `team.read`. It returns `null` unless the team's one application is `accepted`, `offer_sent`, or `confirmed`. Otherwise it validates and returns the current published communications-policy ID/version, venue/address/map, start/end, ordered next steps, and Discord invite/label. It returns no notification destination, delivery telemetry, internal application reason, project text, or another team. The separate unauthenticated `system.getPublicState` response omits venue, accepted-team dates, next steps, and Discord entirely.

### `participant.attendance`

Returns only the caller’s venue state; applicable active/next sessions and per-session states; latest accepted scans; finalized derived results; own venue/session dynamic-QR capability; and own latest result-review case with its participant-facing resolution note. The participant may open one self-scoped case for a closed expected session when none is open. Team availability contains counts/coarse state only and excludes another member’s timeline, remedy, or exception detail.

### `support.mine`, `support.staffList`, and `support.detail`

`support.mine` requires the caller's self-scoped support read grant and returns at most their 20 newest reported cases. It derives reply availability from the independent self reply grant and closed state. `support.detail` returns reporter-visible actions only for the reporter; an exact-case or event-wide staff reader receives the internal timeline as well. Reporter and staff access are recomputed on every query. When the current read grant ends, live lists become empty, the summary becomes zero, and an open detail becomes unavailable. A subscribed client does not receive an authorization error while it removes the protected view.

`support.staffList` returns at most 80 cases covered by event-wide read or the caller's exact-case grants and reports when that display limit is reached. Active state merges bounded indexed open, investigating, and waiting ranges; resolved and closed use their own state ranges. Exact totals come from the fixed `supportCaseStatShards` set, and row summaries come from `supportCases`; the list never reads action history. Every row reports management capability separately. Event-scoped create capability is independent from read and manage.

The lists subscribe to bounded `supportCases` ranges and the event statistics row. Only the selected detail subscribes to `supportCaseActions`. A reply, state change, note, or owner change appears on the participant, event-app, and operations surfaces after the accepted transaction without polling or a client-owned case state.

### `rehearsals.list`, `rehearsals.detail`, and `rehearsals.scenarioHistory`

`rehearsals.list` returns at most the 20 newest event runs for an event-wide reader or the exact runs named by `rehearsal.read` grants. It computes the five scenario counts, assigned/required workstream counts, last activity, and separate manage/execute/complete flags from current grants. Event-wide management is required to create a new run.

`rehearsals.detail` requires read access to the exact run. It returns the copied scenario contract in sequence, current outcomes, active-state status for each routed owner, and current action flags. `rehearsals.scenarioHistory` returns at most 100 ordered append-only actions for one scenario after rechecking that the scenario belongs to the readable run. Neither query treats ownership or role as authority.

`rehearsals.ownerOptions` is a paginated active event-account picker available only to an exact-run or event manager. Choosing a person changes routing metadata only. Run, owner, scenario, and history subscriptions update after the accepted transaction.

### `operations.attendanceResultReview`

Returns one exact closed-session participant result, present duration, confirmation/late state, a bounded immutable event history, and recent remedy cases only after `attendance.remedy.read` covers that attendance session. The response separately reports whether the caller holds open or decide authority; those grants never substitute for read access. Restricted decision reasons are absent from the participant query.

### `operations.attendanceExports`

Returns only the caller's ten most recent purpose, selected columns, state, expiry, snapshot time, row/byte count, checksum, and failure category for one attendance session covered by `attendance.export.identifiable`. It never returns participant rows, an object key, bucket, or URL. Request and download are separate protected calls; event-wide permission may satisfy an exact-session check but role, attendance-summary access, and scan execution cannot.

### `emergencyPacks.list`

Requires event-scoped `emergency_pack.read` and returns at most the ten newest pack records: requester name, purpose, spare counts, pending/ready/failed/derived-expired state, request/snapshot/completion/expiry times, aggregate contents, byte count, source/document checksums, failure category, and version. It returns no participant row, phone/VIT reference, form serial prefix, object key/version, bucket, or signed URL. Preparing and printing use independent permissions and do not follow from list access.

### `participant.intake`

Returns the current fixed or generated prompt and accepted answer state. It also returns phase and checkpoint progress, the live team roster, lead and invite capability, submission-materialization state, freshness attestation, proposal preview, current immutable proposal version, deadline for the team's verified class, and next allowed action. It returns the latest novelty number only when the stored fingerprint matches the saved idea. It never returns an embedding, similarity, corpus entry, theme, prompt, provider request ID, system instruction, another team's text, or model diagnostics.

### `noveltyConfiguration.current`

Requires exact event-scoped `configuration.novelty.read`. It returns the fixed model/width, policy, complete bounded curated entries without vectors, provider readiness, current draft/import state, published version, event version, and independent draft/import/publish capability flags. It never returns participant preview rows, ideas, fingerprints, provider request IDs, or stored embeddings.

### `admissionPolicyConfiguration.current`

Requires exact event-scoped `configuration.admission.read`. It returns the current published policy and its exact optional model child, at most one complete draft pair, their checksums, the event version, whether any application already freezes publication, and independent draft/validate/publish capability flags. It returns configuration content, not applications, participant profiles, AI recommendation records, human reviews, decisions, offers, reservations, or judging data.

### `participant.integrationEvidence`

Returns the caller's team-owned GitHub repository set and Figma file set. It returns repository kinds/purposes, topic/webhook state, and per-resource metrics. The response contains one materialized GitHub team summary and one materialized Figma team summary. It also contains the latest checkpoint-set summary, changed-frame/path lists, preview-set state/counts, and freshness fields. Repositories are ordered by the team’s display order. Combined GitHub commit identity is explicitly observed and becomes a labeled lower bound when any repository's bounded response is incomplete. The Figma summary reports shared design totals and explicit incomplete/dirty/preview-attention counts without interpreting effort or quality. It never returns an OAuth grant, installation token, S3 object key, provider preview URL, or another team's provider resource.

### `admissions.reviewQueue`

Returns active or completed `admissionReviewAssignments` for the current person only after the matching exact `application.review.read` grant is still active. The row includes the current immutable member snapshot, current proposal version, and the caller's own current recommendation. `application.profile_context.read` adds permitted class and year context, deterministic band, and band-specific guidance. `application.ai_recommendation.read` adds the current structured AI state and record. Peer human recommendations appear only after the caller submits a current-content recommendation. Contact, eligibility evidence, and judging data never enter this query. Role is not read.

### `admissions.detail`

Requires `application.read` or assigned `application.review.read` for the exact application. Profile context and the structured AI record still need their separate read keys. Assignment history includes each assignment's application-content version and whether the caller may open its evidence, so operations can distinguish reviews submitted on different versions without loading historical proposal text up front. `application.ai_recommendation.run` adds only the current retry target when the server-side retry predicate passes. It does not add the recommendation body. The response updates when a retry advances the application pointer.

### `admissions.reviewAssignmentEvidence`

Returns the most recently submitted human review for one reviewer and application-content version together with that version's immutable `projectVersions` snapshot. It requires exact `application.read`, or the assignment owner with exact `application.review.read`. The project snapshot is resolved from the stored project-version sequence and application-content-version offset; it does not reconstruct or overwrite historical content.

### `admissions.capacity`

Returns application/review coverage, human decisions, AI used/cleared/overridden/unavailable counts, active offer reservations, confirmed participant counts, and remaining capacity. Detailed personal data and recommendation explanations require narrower queries.

### `reviewer.now`

Returns clock-in state, active panel seat, current page, active session summary, generic round-pause state, save state, and next action. It returns one reviewer’s work only. A pause removes the new-review start action but does not block saving or submitting an already-started review; internal incident text is absent.

### `reviewer.activeContext`

Returns the fixed project/rubric/evidence-checkpoint-set context for the assigned active session and that reviewer’s scorecard.

### `reviewer.integrationEvidence`

Accepts only the checkpoint-set ID attached to the caller's assigned current/recent review. A GitHub request must also name a repository entry in that set. The response returns the ordered repository index and the selected repository’s pinned tree and file-view capability. It returns normalized Figma page/frame facts and captured version/comment activity. It can return a comparison with the linked previous judging checkpoint or one bounded child page from the pinned raw Figma tree. A layer request rechecks the assignment, exact evidence grant, checkpoint, binding, snapshot, artifact ownership, stored/decoded sizes, checksum, and provider version. It returns at most 60 children plus bounded layer/layout/style/component/text/prototype facts. Opening one Figma frame or comparison side signs the exact stored object, then one final mutation repeats the assignment and grant checks, revalidates every requested fact and private manifest, audits the open, and releases the URL only while its 60-second server-clock lifetime remains. A newer live team checkpoint set can be advertised, but it does not replace the scoring context.

### `operations.roundBoard`

Returns round state, panel summaries, team-state counts, critical exceptions, pause state/version, independent pause/resume capability flags, and stale timestamps. Pause reason and incident title appear only when the caller also holds `incident.read` for that exact linked incident. Detail opens through separate indexed queries.

`operations.roundTeams` requires `round.read` for the exact round. Each team row includes an application ID only when the caller also holds `application.read` or `application.review.read` for that exact application. Review-round access never implies admissions access or creates a dead application link.

`reviewConfiguration.current` requires event-scoped `review.configuration.read` and may list every published round for setup context. Each row carries a server-derived board-read capability. The client links that row into the live board only when `round.read` covers the exact round.

### `incidents.active`

Returns at most 20 newest open or monitoring incidents visible through the caller's exact or event-wide `incident.read` grants. The staff shell uses this projection for its scoped incident banner. Participant and reviewer surfaces do not call it.

### `operationsHealth.overview`

Requires the independent event-scoped `operations.health.read` grant. It returns the event state, server generation time, a severity summary, and only non-zero bounded signals. Each signal contains its stable key, area, severity, count/`atLeast`, optional oldest time, owner, and next action. It returns no resource ID or underlying incident, participant, team, project, repository, Figma, delivery, model, Synesthesia, or score detail.

One server-owned action reads current operational parents and compound event/state indexes rather than scanning historical logs. It materializes the bounded projection every 30 seconds. The authenticated public query reads only that indexed document and returns explicit `missing`, `stale`, or `ready` state. Reaching a source bound produces a separate coverage-limited signal. The query grants no action; drill-down and remediation use their ordinary separately scoped reads and commands.

### `eventLifecycle.current`

Requires event-scoped `event.lifecycle.read`. It returns the current event status/version, whether the caller independently holds `event.lifecycle.manage`, and only the legal next transitions. Each next transition contains its current setup blockers as stable keys and product labels. It returns no participant, application, review, or score record.

`eventLifecycle.transition` requires `event.lifecycle.manage`, current scoped authorization, the exact current event version, a reason, and an idempotent operation ID. It rechecks the transition path and blockers in the write transaction. It then increments the event version and records the authorizing grants and before and after states. The applications-open and applications-closed display follows server time and the two published class deadlines. Participant profile, team, intake, submission, and revision mutations resolve the verified class and recheck its deadline after operation replay and before new work. Leaving `live` also disables the autonomy scheduler, revokes its active run, persists Worker abort intent, and starts resumable inbox cleanup.

### `operationsIntelligence.latest`

Requires event-scoped `operations.intelligence.read` independently from health read or generation. It returns the newest operator-requested brief ID/state, source generation time, validated headline/summary/priorities, terminal category, request/Worker/completion times, and agent/model provenance. It does not return the frozen source snapshot, service identifiers, signatures, or a remediation control. Scheduled and signal-driven intelligence belongs exclusively to the autonomy inbox and run model.

`operationsIntelligence.request` separately requires event-scoped `operations.intelligence.generate`, a stable client operation ID, and no existing active event brief. It inserts the pending row, enqueues the bounded dispatch, schedules expiry, and records the operation/audit event in one mutation. A caller without read permission receives only the new brief ID.

`operationsIntelligenceActions.openBriefStream` and `openCopilotStream` separately require `operations.intelligence.read`. Each returns the exact Worker read URL and a capability expiring within 60 seconds. The brief ticket is bound to the brief ID; the copilot ticket is bound to the deterministic event-subject conversation and instance. Their routes and signature contexts differ. Neither ticket permits POST, abort, attachments, or a domain command.

`intelligenceObservability.briefHistory` independently cursor-pages manual brief lifecycle records newest first. The activity workspace loads older pages explicitly; it never presents a latest-25 sample as complete history.

`operationsIntelligenceActions.submitCopilotTurn` requires `operations.intelligence.generate`, accepts a stable turn ID and bounded message, and sends the exact signed body to the Worker service ingress. A validated accepted receipt must echo the derived conversation and instance. Network failure, HTTP 5xx, or a malformed/lost receipt remains ambiguous and is retried with the same turn ID and message. Only a validated same-ID/different-content conflict is definitive.

`intelligenceRecommendations.detail` requires `operations.intelligence.read` and returns one event-owned proposal's typed arguments, exact provenance/citations, reasoning, status, and version. `intelligenceRecommendations.proposed` cursor-pages every pending item oldest first; `settled` cursor-pages decisions newest first. Triage independently rechecks the current underlying command grant and target version. No top-N overview can hide an actionable proposal.

### `operationsAutonomyPolicyConfiguration.current`

Requires `configuration.intelligence.read`. It returns the immutable published autonomy policy, optional current draft, current non-superseded scheduler state, event version, the exact selected owner with current read/generate capability, and booleans for the caller's independently resolved draft, validation, and publication grants. `ownerOptionsPage` separately searches or cursor-pages active event accounts with the required read grant and reports their generate capability; it has no event-population cap, and clients continue through sparse pages until `isDone`. Validation requires its own key. Draft replacement and publication are idempotent optimistic mutations; publication also requires current authorization and revalidates the exact draft checksum server-side. `disable` resolves the current state transactionally rather than trusting a displayed version, revokes authority immediately, and starts durable cancellation/abort cleanup.

### `operationsAutonomy.status`, `history`, `queuedWork`, and `startManual`

The status query returns the event status, authoritative `canStart`, current published policy summary, scheduler lifecycle/count, and exact active run, including its frozen source checksum and bounded fact high-watermark vector. Run history and queued semantic work are separate cursor-paginated queries, so no old run or waiting trigger becomes unreachable. Worker shutdown is an explicit `not_required | pending | abort_recorded` state. `not_required` means no Worker abort obligation exists; after authority is revoked for admitted work, it remains `pending` until the signed abort intent is accepted and then becomes `abort_recorded`. It never claims that Flue has already settled physically. `startManual` requires `operations.intelligence.generate` and enqueues one idempotent semantic work item. It returns `started` only when it actually claims the event's executor; otherwise it returns `queued` and the item remains visible until serially drained. An exact client-operation retry returns that original receipt after later claim or cancellation.

`operationsAutonomyActions.openRunStream` requires `operations.intelligence.read` and an accepted event-owned run. The ticket is bound to the autonomy agent, run ID, route, and short expiry. Convex run/checkpoint lifecycle remains authoritative; Flue settlement or visible prose cannot mark a business run complete.

### `participantPolicyConfiguration.current`

Requires exact event-scoped `configuration.participant.read`. It returns the immutable published policy, optional current draft, event version, and independent draft/validation/publication capability flags. Validation requires its own key and returns checksum issues plus a participant-visible diff. Draft replacement and publication are idempotent optimistic mutations. Publication also requires the current event/draft/checksum, a reason, recent Google authentication, and complete server-side validation.

### `communicationsPolicyConfiguration.current`

Requires exact event-scoped `configuration.communications.read`. It returns the immutable published policy, optional current draft, event timezone/version, and independent draft/validation/publication capability flags. Validation has its own permission and returns only checksum issues plus a participant-visible diff. Draft replacement and publication are idempotent optimistic mutations; publication also requires current event/draft/checksum, current authorization, a reason, and complete server-side revalidation.

### `attendance.scannerNow`

Returns the registered device’s active station/configuration version, event/session/zone, fixed direction or roving confirmation requirement, allowed methods, recent result receipts, connection policy, and pending-replay limit. It returns no directory, bearer hash, or movement history.

While this scanner surface is mounted, `attendanceActions.scannerHeartbeat` hashes the local installation secret and calls a protected internal mutation. The mutation rechecks `attendance.scan.execute`, the exact station configuration version, active device assignment, and secret hash before touching `lastSeenAt`. Writes are throttled to once per 30 seconds. Operations treats the heartbeat as liveness. It does not treat registration time as liveness. Operations alerts only for stations expected online in the live event/current station or session window.

### `operations.attendanceBoard`

Returns active/upcoming session configuration, sharded totals, indexed participant/team/zone exceptions, station health/throughput, projection freshness, and review-call availability impact. Exact participant history and sensitive exception detail require separate narrower queries.

### `operations.emergencyRollCall`

Returns the exact prepared session/zone, frozen opening counts/checksum, sharded live or final counts, and a paginated expected-cohort roster with current `inside | temporarily_out | not_arrived | departed | elsewhere | unknown` state only when `attendance.roll_call.read` covers that session. Starting and closing require their own independent permission keys.

### `operations.integrationHealth`

Returns one compact row per team/provider with active-resource count, aggregate state, topic/webhook coverage, provider/metadata/content ages, current job state, rate-limit wait, completeness, and next action. The event list reads the current `githubTeamMetrics` and `figmaTeamMetrics` projections only. Opening one team invokes a separate exact-team detail query for ordered repositories and current Figma files/snapshots/previews; protected Figma checkpoint access still requires `integration.artifact.read`. Neither query returns credentials or raw artifacts.

### `intakePolicyConfiguration.current`

Requires exact event-scoped `configuration.intake.read` and returns the published atomic policy, optional current draft, event version, active-pin counts, and whether the caller independently holds draft, validation, and publication grants. The companion mutations replace one whole draft and publish only its exact ID/checksum. There is no participant migration or rollback command.

### `operations.intakeHealth`

Returns answer-save and interpretation latency, Workpool depth/age, success/refusal/invalid/question-policy-rejection/timeout/rate-limit/fallback counts, aggregate question-length/quality evaluation metrics, and affected configuration versions. It excludes answer text, generated-question text, contact data, and provider payloads.

### `scoreGovernance.completeness`, `scoreGovernance.completenessReviews`, `scoreGovernance.roundValueCriteria`, and `scoreGovernance.roundValues`

`completeness` returns the exact round-wide blocker counts, rubric labels, capability flags, and active
export/release state without expanding every review session. `completenessReviews` requires the same
exact-round completeness permission and paginates review sessions through the round/status/update
index before reading their scorecards, immutable submitted versions, reviewers, evaluation, or
correction cases. A page accepts at most 30 sessions. `roundValueCriteria` and the paginated
`roundValues` require the separate exact-round numeric-values permission and are subscribed only
after the operator explicitly opens numeric values. The client may sort loaded rows for display, but
round-wide counts always come from `completeness` and never from the loaded pages.

### `synesthesiaParticipant.state` and `synesthesiaParticipant.searchCatalog`

Return only the eligible participant's active window, personal request/vote usage, participant-visible bounded queue, own vote/report flags, and at most 20 policy-valid active catalog matches. Pending is shared, rejected is requester-only, and hidden is omitted.

### `synesthesiaConfiguration.overview` and `synesthesiaConfiguration.catalog`

Return the bounded windows allowed by the caller's exact window-read scopes plus independent command booleans. Catalog metadata requires event-wide catalog read; its manage flag does not follow from read.

### `synesthesiaOperations.queue`

Requires exact-window queue read. It returns at most 200 request snapshots in operator order. It returns report counts but no report reason. It returns internal notes only where moderation covers the request. Independent action flags cover moderation, scheduling, playback, report resolution, and requester access.

### `synesthesiaOperations.reports`

Requires `synesthesia.report.read` for the exact request or the event. It pages open report reasons through `synesthesiaReports.by_request_state_created`, at most 50 at a time. The music desk subscribes only after an operator opens that request's reports.

### `roundExports.workspace`

Requires exact-round score-completeness read access. It returns the current round/export versions, starter, revision, lifecycle state, frozen counts, failure, verifier, and independent booleans for start/read/verify/retry/reopen. File sizes and short hashes appear only with `round.export.read`; keys, bucket, and object-version IDs never reach the browser. A download URL is released only after a final authorized mutation rechecks the exact round grant, export version, selected file manifest and object version, checksum, and remaining 60-second expiry, then audits the open. The starter is never offered verification even if that person holds both grants.

Subscriptions update only when records read by the query change. Screens use stable IDs and preserve local focus while data refreshes.

## 15. Command surface

| Area            | Main commands                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity/access | provision participant, preview/confirm/list/revoke roster and claim own exact-email row, claim/revoke access invitation, suspend/reactivate event subject, assign/replace role label, preview/apply/migrate permission bundle, grant/revoke one permission, batch grant/revoke, register/revoke device                                                                                                                                                                                                                                                                                                                                                                      |
| Team/proposal   | create/join/leave team, request/accept/decline/cancel lead transfer, start/resume intake, save answer, request a debounced novelty preview, accept fresh-project attestation, preview final submission, submit the current application snapshot, revise the submitted team or proposal before the applicable deadline, start/confirm team integration, add/classify/reorder/archive/replace repository                                                                                                                                                                                                                                                                      |
| Configuration   | draft/validate/publish participant, admission, intake, phase, checkpoint, accepted-team communications, and operations-autonomy policy versions; create novelty draft, replace its complete curated entry set, and publish its exact ready revision under four independent novelty grants                                                                                                                                                                                                                                                                                                                                                                                   |
| Admissions      | assign application, retry the current failed/stale structured AI recommendation, submit own human recommendation, request information, prepare/use/clear/override/publish human decision, correct the deadline-frozen snapshot under exception, send/respond/expire offer                                                                                                                                                                                                                                                                                                                                                                                                   |
| Communications  | read/draft/validate/publish next-steps/Discord/notification policy under four independent event grants, enqueue a policy-pinned participant status notice, record provider result, retry/disable an exact destination, grant/revoke call consent, send push first, claim/cancel a consented call escalation, and record call-provider events                                                                                                                                                                                                                                                                                                                                |
| Venue           | resolve a VIT ID barcode, static external event pass, or manual fallback; record/read staffed venue check-in, approved identity exception, or reversal under independent person scopes; assign/freeze table; report mismatch                                                                                                                                                                                                                                                                                                                                                                                  |
| Attendance      | draft/validate/publish plan, schedule/open/extend/close/cancel session, enrol/suspend/rebind VIT ID barcode, issue/revoke external badge, read an own static external pass, link an external physical ID, assign/disable/make available station, record scan, reconcile live transition, request/open/approve/decline finalized-result review, excuse expectation, open/close roll call, purpose-limited export, enter/upload/read/verify numbered paper sheet                                                                                                                                                              |
| Round/panel     | publish plan, clock in, mark unavailable, page substitute, accept/decline page                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Queue/review    | staff route directly into a panel queue, call, hold, resume, move, read current participant availability, record one scoped availability exception, scan reviewer presence, start, extend, complete                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Score           | save own draft, submit own scorecard, enter/upload/read/verify or reject one signed paper review, request/approve correction, resubmit, void                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Support         | create/read/reply to own case; event staff log a walk-up case; exact-case or event-wide readers inspect; exact-case or event-wide managers assign/clear owner, add public/internal note, and change state                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Rehearsal       | create one run from the 62-scenario template; assign workstream owners; start/cancel the run; record scenario start/pass/fail/block/rerun; sign off only after every scenario passes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Operations      | read or request a source-bounded manual intelligence brief; use the private copilot; publish/stop an effect-bounded autonomy policy; enqueue a manual autonomous run; supervise durable schedule/signal work; inspect paginated sanitized traces; review exact cited typed proposals; prepare/read/open an expiring emergency pack through three independent event grants; read/create/approve/resolve incident; pause/resume new calls and review starts for one exact open round linked to a readable active review incident; import/verify paper record; start close/export, retry export, issue protected export download, independently verify/close, reopen/supersede |
| Integration     | verify/deduplicate provider event, refresh metadata/content, reconcile, render, retry/pause/disable binding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Synesthesia     | search/request catalog track, add/remove vote, report request, add/update catalog track, create/update/publish/close window, pause/resume playback, read queue, approve/reject/hide request, queue/pin/defer request, acknowledge start/played/skip, resolve/dismiss report, suspend/restore requester music access                                                                                                                                                                                                                                                                                                                                                         |

Each command has one server implementation used by web and mobile. A mobile-specific API does not apply different judging rules.

Production logical backup and staging restore rehearsal are intentionally outside this application command surface. The typed pnpm commands invoke the Convex CLI with separate operator deploy keys; the restore command cannot target production and records proof in versioned recovery storage.

## 16. Concurrency cases

### Novelty preview versus typing, save, and corpus publication

The browser gives each debounced preview a new client request ID and monotonic local sequence. An older network response can finish, but it cannot replace the newest displayed result. `novelty.beginPreview` resolves one exact team/client-request range transactionally; a replay returns its settled result, while reuse for different text fails. The same mutation applies the team rate limit before inserting the one request row.

The action performs provider work outside a transaction. Settlement reads the request, team, pinned corpus, and shared proposal draft. It stores the terminal request once and copies the number onto the draft only if the saved idea fingerprint and corpus pin still match. If a save, edit, submission, or revision commits first, the action retains only request history. If settlement commits first, the later edit clears the copied fields. Neither order can leave a stale number attached to changed text or copy it into an immutable proposal version.

Corpus publication changes only the event pointer for later drafts. An existing draft names its prior published corpus, which remains queryable as `superseded`. A preview that began before publication therefore finishes against the same immutable vector set; it cannot compare one idea across mixed corpus versions.

### Permission grant versus revoke

Both commands carry a client operation ID and the target’s current access version. Grant checks `access.permissions.grant_any` or one matching grant-scoped row; revoke checks the separate revoke permission. One commits; the stale command fails with `ACCESS_CHANGED`, while the subscribed detail query refreshes to the committed effective-access view. Authorization checks read committed active grants on every protected call, so a revoked grant cannot survive in a role/session cache.

### Assignment teardown versus manual grant

Ending a panel, station, team, incident, or release assignment revokes active and scheduled grants by that assignment’s source ID and advances each affected subject once. A concurrent manual grant has a different source and remains active. Re-running teardown finds no current source grants, changes no access version, and cannot revoke the manual grant.

For a scanner station, device revocation, assignment removal, configuration-version advance, grant teardown, operation result, and audit event share one Convex mutation. A scan or heartbeat racing disable either commits before that mutation or retries against the revoked device and changed station version. Re-enabling the station creates no authority; a new phone registration must attach a fresh secret and source grant group.

### Assignment grant creation versus stale access preview

Each panel, review, reserve, page, team, or scanner assignment writes its source-attributed grant group and advances the target subject in the same transaction. Several rows in one group produce one version change. Convex retries a concurrent operation against the committed source rows and subject; an exact retry finds no missing row and advances no version. A permission-management confirmation carrying the older version fails with `ACCESS_CHANGED` instead of committing over the assignment.

### Admission-review assignment versus cancellation or submission

Assignment compares the application version and the indexed active application/reviewer range, then inserts the routing row, two source grants, count/version update, operation result, and audit together. Two managers using the same application version cannot both cross it. Cancellation compares both application and assignment versions and reads the same active routing row as review submission. If cancellation commits first, assignment grants are revoked and the stale save must re-authorize; if submission commits first, the row is completed and cancellation rejects it. No order can leave a completed-and-canceled row or revoke an independent manual grant.

Review submission compares `applications.contentVersion`, not the routing/application housekeeping version. Two assigned reviewers of the same unchanged content may therefore submit together. Both transactions update the application completion projection; Convex conflict retry makes the second increment start from the committed first increment. Replacing one review for the same content appends a new evidence row, supersedes that reviewer's old row, and leaves the completion count unchanged.

### Scheduled transition versus revocation

An exact start/end job and the repair sweep both reload the grant and transition only `scheduled` or `active` rows whose server-time boundary is due. If revocation commits first, the transition sees `revoked` and does nothing. If activation commits first, source or direct revocation sees the current active row and revokes it. Convex conflict retries serialize both orders, and the final state can never be active after a successful revocation.

### Bundle migration versus manual override

A bundle migration selects one retired source version and at most five exact completed application batches. Preview binds the source and destination version checksums, source batch/grant state, target access versions, resolved destination bindings, validity, destination-source history, and every diff action. Confirmation reruns the same reads with current authorization. A concurrent source revocation, target access change, destination application, bundle publication, event-end change, or binding-resource change can commit first and change the checksum/version. It can instead conflict with the mutation. In both cases, the old confirmation writes nothing and needs a new preview.

The successful mutation creates or reuses current-version grants. It supersedes only current grants from the selected old batches. It preserves explicitly inactive old- or destination-version identities and advances each affected subject once. It completes every per-target migration batch, records one audit event, and stores one idempotent operation result. Manual grants and other bundle sources are not selected, so they remain. All selected people commit or none do.

### Bundle application versus target access change

Preview captures the target's current `accessVersion` and a checksum of the exact published bundle, resolved event-owned scopes, target, and expiry. A concurrent grant, revocation, subject change, or bundle publication commits first or makes application stale. Convex retries the mutation against current reads; the command then rejects the old preview instead of materialising a mixed grant set. An exact application retry resolves its recorded result through the actor's operation ID.

### Two requests or votes for one track

Two requests read the same `by_window_track` range. Convex retries one transaction; it returns the committed visible request instead of inserting another. Two vote changes read the one request/member row, participant's active-vote range, and request counter. One transaction commits first; the retried command observes that state and cannot create a second vote or drift the count.

### Two playback starts

Both commands read the request version and the `playing` range for the exact window. One marks its request playing and appends the acknowledgment. The other retries, observes the playing row or stale request version, and changes nothing. Pause and close read the same playing range, so neither can cross an active start.

### Report resolution versus another request write

Report resolution reads the open report and parent request before changing both the report state and open-report count. A vote, moderation action, or another report resolution touching the request commits first or conflicts; Convex reruns the transaction against the current request count/version. The expected report version prevents two dispositions.

### Requester music suspension versus participant action

Suspension and restore compare the current membership access version. Participant request, vote, and report commands read that same access row before writing. One transaction commits first; a participant action retried after suspension is rejected, while a stale access command changes nothing.

### Two team joins

Both mutations query active membership by event/person. One commits; the other retries and returns “already in a team.”

### Leadership transfer versus team change

Accepting a transfer checks its pending ID, both active memberships, expected team version, and applicable deadline. A concurrent leave, removal, second transfer, or final submission commits first or loses on retry. The losing action returns the current lead and team state; it cannot leave zero or two active leads or retain stale lead grants. If an application exists, acceptance also creates its next immutable roster snapshot in the same transaction.

### Two answer saves

Both carry the expected intake-session version. One commits a new immutable answer version. The other retries against the changed session and returns the current prompt/answer instead of replacing it. Ephemeral collaboration presence names the exact other membership and exact idea or question being edited. The browser preserves unsaved tab-local text, but it creates a recovery notice only when the committed draft records a different membership as its last editor.

### Late model interpretation

The completion mutation compares session, active answer IDs, input checksum, and paired configuration versions. If any changed, it marks the interpretation stale. It cannot alter the current question or confirmed fields.

### Final submission versus membership change

The preview records the draft, team, authoritative member counts, and lead versions. Submission start requires the current lead and exact-team `application.submit`; granting that permission to a non-lead is insufficient. It reads those values, the applicable class deadline, and the idempotency key in one mutation. Editing presence remains advisory and cannot become a stale-tab veto. The lead is warned when another member is typing and submits the exact committed preview. The mutation then creates a durable attempt and uses an internal materialization guard to hold the previewed state. Bounded mutations page that stable active roster into immutable member rows and finalize the proposal and application only after row totals and class totals equal the team projection and pinned policy. A concurrent join, leave, lead transfer, profile edit, committed answer edit, or submit-grant revocation either commits first and makes the preview stale or reaches the transient guard and retries after materialization. A presence heartbeat and a working-field autosave do not alter the committed preview. A failed validation releases the guard and retains the failed attempt. A completed submission does not use that guard to block later team changes.

### Submitted team change versus review or AI completion

Each join, leave, removal, switch, or accepted leadership transfer checks the applicable class deadline and its ordinary team invariants. When the team has an active submitted application, the same transaction rechecks team bounds, participant class, profile completeness, current participant-policy acceptance, and exactly one lead. It materializes a fresh roster snapshot, creates a new immutable project version with roster-revision provenance, advances the application content version, keeps active assignments on that new version, and supersedes stale human and AI output. If any step fails, the membership or leadership change also fails. Review or AI work for the prior version can commit first and then be superseded, or retry after the change and become stale.

### Proposal revision versus review, AI completion, or deadline

The lead revision command checks the exact application, current proposal version, draft version, lead, submit grant, and server time. It accepts only when server time is before `applicationsCloseAt`. The transaction appends one immutable proposal version, advances the application content version, supersedes old human reviews, rebinds active assignments, and makes old AI work stale. A review or AI completion for the old content can commit first and then become superseded, or retry after the revision and become stale. The revision cannot commit at or after the deadline.

Human reviews may commit before the deadline, but an admission decision may not. Decision publication checks server time against `applicationsCloseAt` in the same mutation that checks application and review versions. Therefore a proposal edit and a terminal decision cannot cross the deadline in either order.

### Push acknowledgement versus phone escalation

The first unanswered reminder creates at most one call delivery. Its delay is half the response window, capped at 30 seconds. Its claim reads the current page, consent version, destination, script policy, and page-chain grants. The claim reads the page while acknowledgement writes it, so Convex serializes the race. If acknowledgement commits first, the retried claim cancels the delivery. If claim commits first, the later acknowledgement remains authoritative even if the call proceeds. Neither order changes the in-app response.

### Call callback versus retry

Provider event IDs are unique. A repeated event with identical content is a no-op. Conflicting reuse fails. Active provider states move forward and do not regress on an older callback. A provider dispatch that cannot be proved accepted or rejected becomes `ambiguous` and is not redialled. A backend-to-Worker timeout may retry only the same durable delivery ID, so the Worker's per-delivery object returns the first accepted request instead of creating another call.

### Roster preview versus import, claim, revoke, replacement, or expiry

The preview checksum includes event, source, reason, validity, pinned bundle/version/content checksums, normalized rows, each row outcome, and the exact prior pending row ID/version. Confirmation recomputes the same inputs inside its mutation. If a claim, revoke, replacement, bundle publication, event-window change, or expiry commits first, the preview is stale; if confirmation commits first, the competing mutation retries against the new row state. An exact confirmation operation retry returns the original immutable import instead of inserting another batch.

Claim and revoke both read and update the same pending row version. Only one can commit. Claim also reads the matching email index, event subject, active role, pinned bundle versions, source grants, and operation index, so concurrent identity or access changes either serialize or cause a checked conflict. Claim cannot leave a role, partial bundle, or claimed row without the others because they share one mutation.

### Admission analysis versus application correction

Completion compares the application/project version, input checksum, experience-band policy, admission policy, and model config. A correction makes pending output stale. Publishing a decision can reference only the current valid recommendation or record it as stale/unavailable; no analysis completion can change the human decision.

### Admission publication versus first submission

Publication requires both the event application range and the indexed validating/finalizing submission-attempt range to be empty. Submission start reads the current published admission pair and writes its pinned attempt and transient materialization guard in one mutation. Convex's transaction conflicts serialize a race. If publication commits first, submission retries and pins the new policy. If submission starts first, publication retries, observes the active attempt, and fails with `ADMISSION_POLICY_FROZEN`. The policy pointer, optional model pointer, capacity bucket, immutable project, and application cannot represent different releases.

### Config publication during an active session

Publication changes only the event defaults for new sessions. Existing sessions keep pinned IDs. A migration is a separate previewed command with explicit key mappings and affected-session counts.

### Repository reorder versus add, archive, or refresh

A reorder carries the complete ordered list of current non-archived repository binding IDs and each binding's expected version. The mutation reads the team's entire indexed binding range, rejects duplicates or a changed set, checks every version, then compacts `displayOrder` and versions only moved rows. Convex range and document conflicts make an add, archive, refresh, or competing reorder serialize with it; after retry, a stale command fails instead of restoring any part of its old list. The operation ID fingerprints the complete ID/version sequence, and one audit event stores the accepted before/after order.

### GitHub repository state versus the team summary

Connection, add, archive, sync-start, sync-success, sync-failure, and accepted-webhook mutations update their repository/connection rows and rebuild the same team's `githubTeamMetrics` row in one Convex transaction. Concurrent changes for one team serialize on that row; unrelated teams do not share a write hotspot. A client therefore cannot observe a committed repository transition with an older aggregate. The rebuild requires one metrics row for every visible binding, so the invariant is established when the binding is created instead of hidden behind a nullable query fallback.

### Figma file state versus the team summary

Connection, file-add/archive, metadata-start/success/failure, full-sync-start/success/failure, preview claim/success/failure, webhook-state, and accepted-webhook mutations update their resource rows and rebuild the same team's `figmaTeamMetrics` row in one Convex transaction. Concurrent changes for one team serialize on that row; unrelated teams do not share a write hotspot. The rebuild requires one current metric, snapshot, and preview set for every visible file, so no committed file transition can appear with an older or silently incomplete aggregate. The event board reads only this projection; resource detail fan-out is bounded to the one team an operator deliberately expands.

### Simultaneous VIT-barcode and QR attendance scans

Both commands resolve the same participant projection and open-interval index. One creates the accepted transition. The other retries, finds the accepted state, records/returns a duplicate outcome, and cannot add duration or move counters again.

### Scan while attendance session closes

The scan and close mutation serialize on the session/version and participant interval. A scan accepted first is included in close calculation. A later scan receives the closed session and can only become an authorized reconciliation.

### Physical credential replacement versus old-card scan

The first replacement scan creates no active binding change. The second matching scan marks the previous VIT ID barcode or external badge `replaced` and activates the verified successor in one mutation. An old-card scan that commits first remains a valid historical event. Replacement commits after it. An old-card scan that retries after replacement is rejected and cannot change presence. The pending-attempt expiry checks the unchanged pending version, so it cannot race past verification. A concurrent version-checked VIT suspension or external-badge revocation can win instead. It atomically retires the old credential and pending successor. Verification then fails without activating either record. A later VIT recovery starts a new rebind from the suspended version. If only the success response is lost, a newly identified retry first reauthorizes the person, station, device, and current authorization. It then recognizes the exact already-committed IDs, versions, relationships, lookup, reference, and reason. It returns success without repeating the write or audit event.

### Offline exit and newer online return

Replay keeps the device sequence and capture time but loads current server state. If accepting the older exit would contradict a newer transition, the replay becomes `needs_review`; it cannot rewrite the current projection. A compensating reconciliation may rebuild the interval after human review.

### Session close with a large cohort

The close command fixes the cutoff and interpretation version, moves the session to `closing`, and creates one idempotent finalization job. Scheduled indexed batches close/reconcile intervals and calculate participant results. A retry resumes from the stored cursor; only verified completion changes the session to `closed`.

### Venue scan versus roll-call start or close

Start reads the prepared cohort and current venue projections before inserting the active roll call and its shards. A concurrent scan either commits first and appears in the snapshot, or conflicts, retries, sees the active roll call, and moves its shard. Close reads all shards before changing the roll call to closed. A concurrent scan either moves the active shard first and is included in final counts, or retries after close and changes only ordinary venue presence. It cannot fall between the two views.

### Attendance change during identifiable export

All cohort, attendance-result, identity, and selected profile reads occur inside one internal Convex query, so the CSV input has one logical timestamp rather than one timestamp per page. Later scans or remedies create later state and do not rewrite that file. Generation retries use one deterministic S3 key; once completion records the checksum, a retry observes `ready` and cannot replace it. Download first checks access and signs locally, then a mutation rechecks requester, exact grant, fresh auth, record version, checksum, export expiry, and signed-URL expiry before the URL is returned. A revocation or record change between the checks prevents delivery; a returned URL cannot outlive the export and lasts at most 60 seconds.

### Emergency-pack request, generation, and print

Preparation resolves the client operation before insertion, so a lost response returns the same pack. A new operation derives its 16-hex serial prefix from the event, actor, and operation ID, reads the event/prefix index, inserts the pending record, enqueues the export worker, records the operation, and audits the request in one mutation. Two different operations that collide on that short prefix conflict through the same index range; after retry, one exists and the other fails with an explicit request for a new operation ID. They cannot create two packs whose printed serials overlap.

The internal snapshot query has one Convex logical read point. A scan, station edit, panel edit, or roster change is wholly before or after that point; it cannot change only one page of the document. The worker may retry storage, but completion accepts only the current pending pack and one internally consistent object-version/checksum manifest. Once ready, a later retry observes the terminal record and skips generation.

Print first checks current identity, `emergency_pack.print`, recent authentication, ready state, expiry, and complete manifest before signing the exact recorded object version. Before returning that URL, a mutation repeats authorization/freshness/state checks and compares the pack version and both checksums while writing the audit event. Permission revocation, expiry, or record change between those steps prevents delivery. A successfully returned URL lasts at most 60 seconds and never beyond pack expiry; it conveys no incident approval or import permission.

### Two finalized-result reviews or a stale decision

Opening reads the exact participant/session open-case index and writes the case in one transaction. Concurrent opens serialize; one succeeds and the other returns the existing-open-case conflict. Decision compares the case version and every frozen session/result/evidence field with current state. A decision or other permitted result change that commits first increments the participant result version, so a stale approval cannot overwrite it. Retrying the same operation ID returns the committed case or decision instead of applying the counter move twice.

### Two substitute acceptances

Both load the page chain and empty panel seat. The first fills it and closes the chain. The second retries against the filled seat and receives the accepted reviewer identity permitted for that screen.

### Two review starts

The mutation checks team-round state and active sessions for team and panel. In the same transaction it reads the team's latest lower-round-sequence evidence set, pins that ID in the new manifest, captures the current ordered provider bindings/snapshots, and creates the review. A provider refresh racing the mutation is wholly before or after its read point; it cannot change just one side later. A duplicate operation returns the existing session; a different stale request fails.

### Participant movement versus call, start, or availability waiver

Offer confirmation creates the team's availability row from the immutable offered roster. Accepted venue entry or exit patches that row together with the participant projection. Call reads the current row before changing the queue state or creating review records. If the count is below the published minimum, it writes nothing unless the same request carries a freshly authenticated exact-team exception; that accepted transaction creates the review and its immutable waiver together. Start repeats the availability read and accepts a low count only when that exact review already has a waiver.

A venue transition racing call or start patches the shared team row, so Convex retries the review command against the new count. Concurrent scans for two members of one team also serialize on that row and cannot lose a count. A post-call waiver reads the pending review version, current count, and one-row waiver index before inserting and incrementing the review version. A concurrent start either commits first while the minimum is met and makes the waiver stale, or retries after the waiver and sees it. Two waiver attempts serialize on the same index range and cannot create two rows.

### Round pause versus call, start, close, or incident resolution

Pause reads the active-pause index range, exact round/version, and linked active review incident before inserting one pause and incrementing the round version in the same mutation. Team call, review start, and start-close read the same round and active-pause range. If one of those writes commits first, pause retries against the changed round and rejects its stale version; if pause commits first, the retried call, start, or close sees the active row and writes nothing. Queue placement does not read the pause, so a team may keep or receive its queue position without being called.

Resume compares both pause and round versions, resolves the pause, and increments the round version atomically. Incident resolution reads `by_incident_state`; it cannot commit while any linked pause is active. Already-started review saves, submissions, and completion do not read the pause and remain available throughout the incident.

### Support retry, reply, and staff update

Creating a case, replying, and changing it first resolve the actor's operation ID and exact request fingerprint. A lost response repeats that same request and returns the committed case/version rather than adding another case or action.

Reporter reply and staff update both read the current case version and write the case plus every new timeline action in one mutation. If two writers begin from one version, Convex retries the later transaction; its expected version is then stale and it changes nothing. A reply to `waiting` or `resolved` reopens the case atomically with the reply. Owner assignment checks that the person still has an active event subject, but inserts no permission. Revoking the operator's grant before retry causes authorization to fail even if the UI still shows the case.

### Rehearsal assignment, scenario result, and final sign-off

Assigning a workstream reads and increments the run version while replacing or inserting the one owner row. Concurrent assignments from the same version serialize; the later command retries, sees the new version, and writes nothing until the operator reviews current ownership. Start reads all scenario workstreams and owners, verifies each owner's active event account, checks the active-run index range, and changes the current draft in one transaction. Concurrent starts can leave only one active run.

Scenario outcomes compare only the selected scenario version and do not patch the shared run row. Operators can work different scenarios in parallel without turning the run into a hot write record. Two updates to one scenario serialize through that row; the later expected version is stale. The accepted mutation patches the scenario and appends one action, operation result, and audit event together. Repeating the same operation ID returns the current accepted result without another action.

Completion requires the independent exact-run complete grant, a recent Google session, and the current active run version. Its transaction reads every scenario before writing the run. A scenario update that commits first makes completion retry and observe a non-passing state; completion writes nothing. If completion commits first, a retried scenario update observes the terminal run and writes nothing. All 60 must remain passed at that single transaction boundary.

### Intelligence dispatch, callback, and timeout

One event may have only one active brief. The request mutation reads the newest event row before inserting, so concurrent requests conflict and retry; the later request then sees the active row and fails. Repeating the accepted client operation ID returns the original brief.

The first dispatch writes the frozen snapshot/checksum and changes `pending` to `dispatching`. Workpool retry reuses that pair. The brief ID is passed to Flue with create-only `uid: null`; one request creates the Durable Object instance and later identical requests return `already_exists`. Either receipt can move a still-dispatching row to `accepted`. A callback that arrives first may settle it directly, making the later receipt a no-op. If the dispatch action eventually fails after entering `dispatching`, the outcome remains callback-eligible until the fixed completion deadline because a lost admission receipt is ambiguous; only that deadline turns an unresolved run into failure.

Callback and expiry both read and patch the same brief row. Convex optimistic concurrency makes one commit first; the retry observes `succeeded | failed` and changes nothing. A callback with another source checksum returns `stale`. After either successful or failed settlement, any duplicate callback returns `already_settled`. Invalid model content is rejected before a completion mutation commits, so it cannot consume the first valid settlement. The scheduled deadline classifies an accepted job as `agent_timed_out` and a never-accepted dispatch as `dispatch_failed`.

The browser does not subscribe to a Convex transcript table. It loads Flue's bounded Durable Object history and follows its opaque update offset over the read-only stream. Message positions are monotonic within a stream incarnation; reconnect is at-least-once, so the client deduplicates positions and resets only when the stream reports a new incarnation. The Worker projection exposes permitted user/assistant text and sanitized lifecycle labels only, never hidden reasoning, raw tool input/output, metadata, files, or provider errors.

### Autonomous intelligence enqueue, execution, and continuation

The cron reads only active due scheduler rows. Each evaluation transaction records every newly due schedule slot and every changed qualifying signal episode as immutable inbox work before advancing the cursor. A busy executor never suppresses this write. Exact concurrent observations collide on the same operation key; distinct schedule slots, signal facts, manual requests, and a cleared-then-recurring signal keep distinct keys.

Claiming is single-flight per event policy and fair across events. A claimed inbox row freezes the policy and source into one run. Every signed model/delegation authorization, read page, proposal, and callback revalidates the event, published policy, accountable owner, kill state, frozen allowlist, and current run identity. Reads are snapshot-stable and cursor-paginated; the Worker persists every page and continues until the traversal is complete. It retains a lossless append-only catalog of redacted findings and candidates and uses bounded summaries only as navigation indexes. Durable synthesis pages through the catalog until every artifact is considered. Bounded provider prompts and HTTP pages are implementation batches, never total cognition or evidence caps.

One Flue submission handles a recoverable slice. Before dispatching a continuation, the Worker proves the exact prior submission settled. Convex owns one next-submission outbox item per current submission head; callback and supervision recovery coalesce on it. An accepted receipt advances the head. Network, provider, or Worker congestion retries the same semantic work rather than marking it complete or dropping it.

Policy publication supersedes the prior state and cancels its active run transactionally. The kill switch disables authority without a stale UI-version dependency. Both paths leave a durable abort outbox supervised until the Worker acknowledges it, while unlimited queued rows are canceled or ignored under the disabled policy without blocking the safety command.

### Two queue moves

The first updates queue and team-round versions. The second expected-version check fails and returns the current state.

### Score draft from old device

The patch carries expected `draftVersion`. A stale patch is not merged into the current value. The reviewer sees local and server copies and resolves through the active device/support process.

### Lost submit response

The client queries `operationResults` with the original submission ID. It receives the submitted version or a definite rejection before retrying.

### Paper review versus digital score write

Creating the paper draft checks every current assignment and scorecard version in the same transaction that inserts the one pending review record. The shared scorecard-write seam then rejects draft saves and submits while that record is draft or submitted. Verification either sees the exact frozen state and imports every signed scorecard plus the evaluation/review/team transitions atomically, or rejects without writing any score. A concurrent digital write, panel change, ordinary completion, incident resolution, or round close commits first or fails its own current-state check; no path can produce a partial paper result.

### Round close during late submission

The start-close mutation reads the current round, active-pause range, team states, reviews, evaluations, scorecards, corrections, and paper records; writes the normalized snapshot/entries; moves the round to `closing`; and enqueues export generation in one Convex transaction. An active pause blocks the command. A concurrent valid submission either commits first and is included, or the transaction retries against `closing` and the score write fails. There is no moment where writes remain open after the snapshot exists.

The export action is not trusted as a state transition. It pages only the frozen entries, recomputes selected results, writes exact-version S3 objects, reads them back, then submits the current export version to a completion mutation. A stale worker, retry, changed round pointer, mismatched count, different S3 object version, or checksum mismatch cannot publish `uploaded`.

Verification first rechecks exact read/verify grants, current authorization, two-person separation, attestations, and versions; then reads the recorded S3 object versions and hashes outside the transaction. Its final mutation repeats every permission, actor, state, snapshot-pointer, and expected-version check before changing export and round together. Two verifiers may perform reads, but only one current mutation closes; the other receives a changed-version result. Reopen similarly checks the verified export and active snapshot pointers, later-round state, and both expected versions before superseding the export and reopening in one transaction.

## 17. Data retention

Board must set exact periods. The schema supports separate policies:

- auth sessions and expired intents;
- participant contact/eligibility data;
- attendance credential records, short-lived QR tokens and staffed resolutions, raw scan attempts, accepted presence events, intervals, derived results, roll calls, identifiable exports, and restricted emergency packs as separate retention classes;
- intake answer versions, generated questions, model interpretations, submitted proposal versions, team checkpoint drafts, and immutable checkpoint submissions;
- immutable curated novelty corpus versions/entries, short-lived novelty preview request metadata, and no-text team-density vectors as separate retention classes; preview and team-density rows contain no raw idea, editing vectors expire quickly, obsolete durable vectors are deleted when accepted text changes, and copied draft signals expire with the mutable draft;
- admission AI recommendations, human application reviews/decisions, and their policy/source links as separate retention classes;
- participant notification content/delivery metadata and disabled destinations;
- provider credentials;
- integration bindings, checkpoint sets, facts, snapshots, raw Figma artifacts, comments, previews, and short-lived GitHub blob cache;
- reviewer private notes;
- submitted scorecards and audit events;
- support/incident records and linked round-pause/resume history;
- intelligence source snapshots, validated outputs, sealed recommendation evidence, model/agent provenance, failure records, and durable Worker instance state as one separately approved retention class; every product-terminal, canceled, or revoked path durably schedules an idempotent purge of private Worker read/finding/candidate/support artifacts before terminal settlement or abort acknowledgement, and the run Durable Object completes deletion independently; a recoverable provider/transport interruption remains nonterminal and retains those artifacts for continuation; exact admission receipts have no timer while the run is active, the terminal-callback outbox atomically persists its strict payload and wakeup and retries before closing admission, and terminal settlement or a recorded abort deletes receipts in bounded pages and leaves only its durable run-bound closed tombstone;
- release-rehearsal runs, workstream routing, copied scenario contracts, and append-only outcomes/sign-off as a separate launch-audit retention class;
- Synesthesia catalog metadata, windows, requests, votes, reports, playback acknowledgements, and participant music-access state as separate retention classes;
- exports, logical-backup ZIP/manifests, staging safeguard backups, and rehearsal results as separate retention classes.

Provider credentials should be deleted soon after the last dependent team checkpoint and complaint window. Disconnecting one team removes its authorization reference and webhook; it does not revoke a shared Figma grant still used by another team. Revoking the provider grant marks every dependent binding for reauthorization. Historical snapshot manifests remain until their evidence-retention date, while GitHub blob cache expires after the review window.

The event privacy notice separately states that project text may be sent to OpenAI for live embedding comparison, intake interpretation, and structured admission analysis, and explains that the latter receives a policy-derived experience band. Responses and admission requests use `store: false`; the embeddings request has no storage switch. The event must not claim zero provider retention because ordinary API abuse-monitoring logs may retain content for up to 30 days unless approved OpenAI data controls apply. Internal preview metadata, interpretations, generated questions, and admission recommendations follow their approved record periods and can be deleted without deleting participant-written answers, submitted brief versions, or human decision history.

Operational judging records use status/versions rather than hard deletion during the event and complaint window.

Attendance QR tokens expire quickly. Encrypted scanner queues expire after their short recovery window. Exact movement events remain only through the approved event, safety-incident, attendance-correction, and complaint window; longer-lived attendance aggregates retain no bearer material or sensitive exception detail. Deletion of raw events happens only after any linked incident, support case, manual sheet, or audit hold has closed.

## 18. Schema acceptance

- A role label alone authorizes no protected read or command.
- Any event-linked person can receive an atomic permission regardless of role and can use it only inside its exact event/resource scope and validity window.
- A person with no role label can use a manual permission after an explicit event access invitation; suspending their event subject blocks every grant without deleting history.
- Cross-event and wrong-resource IDs fail even when the caller has the same permission key in another scope.
- A route shown by a cached bootstrap fails after the underlying permission is revoked.
- Applying a bundle creates individually inspectable grants; editing the bundle changes nobody until an explicit migration batch completes.
- A bundle migration requires independent exact bundle and target authority, accepts no more than five exact source applications, rechecks the full preview and access versions, and commits every selected person or none.
- Migration supersedes only current grants attributed to the selected old applications; manual/other bundle sources remain, and an explicitly revoked old or destination grant is not resurrected.
- Changing a templated role changes only the source-attributed grants owned by the prior and selected role rows, after validating every addition/removal against the actor's ceiling; bundle application remains separate.
- Revoking one of several matching grants preserves access until the final matching grant is revoked or expires.
- A future grant is stored as scheduled, cannot authorize early, and records activation only through a current-state transition.
- Exact lifecycle jobs and the bounded repair sweep never reactivate a revoked or superseded grant, and expiry is enforced from server time even before `expiredAt` is written.
- Source teardown revokes both active and scheduled grants and advances each affected subject once; an idempotent rerun advances nobody.
- A logical assignment grant group validates one active target account, advances that subject once when it creates rows, and leaves the version unchanged when every source row already exists.
- Grant and revoke authority are independent, and both are event-scoped.
- Grant authority does not execute the permission it may grant, and scoped grant authority cannot create another grant/revoke authority.
- Each scoped delegation row covers one permission key, resource-scope ceiling, target-person boundary, and expiry ceiling; it cannot create broader delegation for its own caller.
- Reading access, finding people, assigning role labels, importing rosters, managing bundles, granting, and revoking fail independently when their exact keys are absent.
- Roster preview rejects malformed/duplicate rows, unsupported roles, too many rows/bundles, missing event end, foreign or binding-dependent bundles, and validity beyond the event without writing.
- Event-wide roster import cannot be inferred from exact-row read/revoke access; selected bundles also require their own exact read/apply coverage.
- A stale roster preview writes nothing, an exact retry returns one prior result, and competing confirm/claim/revoke/reimport/expiry transitions cannot produce two pending rows or partial access.
- Claim succeeds only for the exact current verified Google email, leaves a claimed row unchanged on later import, and materializes no participant- or resource-bound bundle entry.
- Rehearsal read, manage, execute, and complete fail independently at exact-run and event scope; a workstream owner or role label with no matching grant sees nothing.
- A run starts only when each copied workstream has one active accountable event person and no other run is active. Ownership creates no grant.
- Scenario updates require an active run and current scenario version, append exactly one action, preserve terminal history through an explicit rerun, and resolve a repeated operation without duplication.
- Final sign-off requires all 62 current scenarios to be passed, a current run version, the separate complete grant, and current authorization; a concurrent scenario change cannot cross the completion boundary.
- Participant profile records distinguish full/preferred name, permitted contact, institution, current year/role, and class-specific fields, while model inputs exclude those identity/contact values.
- A Synesthesia catalog entry is unique by event/provider/track, participant search is bounded to active tracks allowed by the current published window, and no media/provider token is stored.
- One window/track has one request; one participant/request has one vote and one report; one window has at most one playing request.
- Synesthesia window, request, report, catalog, playback, and access commands reject stale versions and resolve repeated operation IDs without duplicate effects.
- Exact Synesthesia window/request/person grants expose only their resource; queue read alone reveals no internal note or report reason, the exact report query can page every open reason, and music suspension changes no event account or grant.
- Every project is recorded as `fresh_for_event`; there is no continuation classification or participant-selected build stage.
- A team checkpoint plan contains exactly ideation, intermediate-update, and final-update definitions bound to their matching phase keys; publication fails without a complete published phase schedule.
- A team that starts a checkpoint keeps its exact question-definition version while a later plan changes only teams that have not started that checkpoint. A current schedule revision may change future or permitted active-end timing without rewriting question history.
- Two team devices cannot cross the same checkpoint draft version, and replaying one accepted operation cannot create another edit or submission.
- One team/checkpoint key has at most one immutable submission. It records the accepted schedule/window, due/close boundary, timing, source draft version, and actor.
- Participant checkpoint submission never creates or changes queue, team-round, review, evidence-provider, evaluation, or score state. Late or missing is context, not an automatic penalty.
- A review evidence transaction pins only a checkpoint submission that already existed at its capture time; reviewer reads and verified exports follow that exact ID after later team or provider changes.
- Every introduction asks two published fixed questions. It then fills exactly two more required slots with validated, grounded generated questions or their published fallbacks. Later checkpoints use their separately published fixed questions and do not reuse this route.
- A novelty corpus publishes only from one complete 5–300-entry ready set whose embeddings are finite native 1,536-value `text-embedding-3-small` outputs. Draft, entry replacement, publication, and read fail independently without their exact event grants.
- A novelty request stores no raw idea, performs no provider call for sensitive-looking text, applies the event's exact team rate limit, and returns only one whole-number result.
- A repeated preview ID cannot create another row or name different text. Provider failure leaves intake usable. A completion attaches only while the saved idea fingerprint and pinned corpus match.
- A changed saved or submitted idea invalidates older team vectors and running previews in its accepting transaction. Provider failure cannot keep the previous idea searchable, and an older action cannot reinsert it.
- Whole-idea retrieval stores at most one row per team lifecycle. Editing and durable rows collapse to one strongest match per team before density is calculated.
- Novelty number and similarity are absent from proposal versions, admission-model input, human admission evidence, review evidence, judging records, and score exports.
- A model result with unknown IDs, stale answers, invalid schema, a repeated/compound/overlong/prohibited question, refusal, or late completion changes no authoritative project field or visible prompt.
- Every submitted follow-up snapshot retains its immutable question ID, ordinal, wording, purpose, source, and participant answer.
- Editing an answer or publishing configuration cannot erase answer history or rewrite an immutable proposal version.
- A participant cannot hold two active team memberships.
- One active team has exactly one lead; an accepted transfer atomically moves role/grants and refreshes any submitted application snapshot before the applicable deadline.
- Final submission explicitly confirms and atomically starts durable materialization for one exact draft, roster projection, and lead. Bounded resumable mutations materialize the exact active-member rows before the application exists. Stale previews fail, but completed submission does not block later valid team commands.
- Before the deadline for the team's verified class, a valid roster, lead, or proposal revision advances the current immutable application snapshot and invalidates stale human and AI output. At the deadline, the latest snapshot becomes final.
- Participant-policy read, draft, validation, and publication fail independently. Two writers from one observed draft state leave one current draft; stale publication changes neither policy pointer nor event version.
- Publishing a participant policy edits no membership or profile. Completeness is derived from the current immutable version. Consent appends that exact version to the event membership once. A participant must accept it before saving a profile, creating or joining a team, or submitting the project.
- Team creation, joins, leaves, and removals load the current participant policy inside their transaction and maintain authoritative class-aware counts on the team root. Roster UI reads paginate independently of the configured maximum. Creation and join require eligibility plus current acceptance, but they do not require profile completion. They reject any roster that would contain both participant classes. Submission start pins that policy and validates root counts. Its bounded roster materializer enforces complete class-aware profiles, exact counts, team bounds, and one verified class before pinning the policy ID in the first immutable proposal version. A post-submission team change repeats the full submitted-roster validation and writes the next snapshot atomically.
- Admission-policy read, draft, validation, and publication fail independently. A complete policy and its optional model replace and publish together; two competing draft saves leave one current pair, and a stale publication changes neither event pointer nor capacity.
- Publication creates one zero-reserved overall capacity bucket for the exact policy and atomically moves the policy/model pointers. An enabled policy always has one matching model child; disabled mode has no model pointer and never blocks human review.
- The first application submission freezes the event's admission release. A concurrent publication either commits first and becomes the application's pin or loses without changing any policy, model, capacity, project, or application row.
- One person cannot submit two active recommendations for the same application, regardless of role or grant source.
- A structured AI admission recommendation is source- and policy-versioned, applies the deterministic year/study band, uses no numeric judging score, and cannot mutate application state, capacity, offer, queue, or judging records.
- A human admission decision records the actor/reason and whether the AI recommendation was used, cleared, overridden, stale, or unavailable. Model failure never blocks the decision.
- A manual AI retry needs `application.ai_recommendation.run`, the current failed/stale recommendation, and current optimistic versions. It preserves the prior row, creates one replacement per operation, reveals no result without read authority, and has no human-decision side effect.
- Human acceptance reserves no capacity. Sending an offer atomically reserves the exact immutable deadline-frozen roster against overall capacity. Only one reservation can be active for the application.
- Only the current lead with exact-team response authority can confirm or decline an open offer. Confirmation preserves the reservation and is the only admission transition that enables attendance and review queues.
- Decline, scheduled expiry, and reasoned revocation release the exact reservation once. Repeated or stale expiry work cannot release twice or undo confirmation, and revocation returns the team to selected state without changing its deadline-frozen roster.
- Communications-policy read, draft, validation, and publication fail independently. Two writers from one observed draft state leave one current draft. Stale publication changes neither the policy pointer nor the event version.
- An unauthenticated event read exposes no accepted-team venue, next step, or Discord field. An exact-team participant projection returns the current published policy only for `accepted | offer_sent | confirmed`. Waitlisted, declined, submitted, and unrelated teams receive no policy payload.
- Publishing a new communications policy updates eligible portals without changing an already queued delivery's pinned policy/wording. An important state change creates a deduplicated official notification delivery whose receipt is not treated as acknowledgment.
- Publishing an admission decision creates one delivery per locked team member in the same transaction, while provider failure cannot change or roll back the portal decision.
- A participant self query returns only that membership's minimal transport state. Detailed delivery rows and commands independently require exact-person communications read/manage grants.
- Only a structured provider non-acceptance can retry automatically. An ambiguous request or expired lease becomes `unknown`. A manual retry creates a new linked row only from the latest definite failure. Concurrent retry, stale versions, a changed/disabled verified email, and an unknown outcome cannot create another attempt.
- Signed duplicate, out-of-order, equal-time, and event-before-send-response Cloudflare events converge by event ID, provider message ID, recipient, provider time, and deterministic event-ID ordering without becoming read acknowledgment.
- A reviewer registration accepts only a complete native token/provider/environment tuple compatible with the device platform; token replacement and invalidation are versioned, and an old provider failure cannot invalidate a newer token.
- A push delivery claims one active page/device/token version at a time, retries only within its page deadline, and keeps provider acceptance separate from reviewer acknowledgment and fallback timing.
- A page attempts push before the 30-second fallback. A call claim requires current consent, the page chain's exact scoped grant, the current script version, and no acknowledgement.
- Call-provider callbacks are append-only and idempotent. Provider acceptance is not reviewer acknowledgement. Consent revocation prevents later claims.
- An update release cannot become current until every hash-addressed asset and the immutable signed release record exist. Repeated identical publication is idempotent, different content under one ID conflicts, and two expected-current activations produce exactly one winner.
- One staffed venue check-in, current-presence projection, and session result have distinct ownership and cannot satisfy one another accidentally.
- Staffed arrival requires an assigned current-plan venue-entry phone plus an independent exact-person record grant. The no-ID exception and reversal use their own exact-person keys, current authorization, reasons, stable operation IDs, and current versions.
- One membership has at most one active venue check-in. Reversal preserves the prior row and changes only its sharded aggregate/team milestone; a later arrival inserts a new row after another fresh staffed resolution. Neither path writes a presence event, interval, venue projection, session participant/result, or judging state.
- A physical-credential command cannot use a membership ID without the matching fresh staffed resolution. One resolution claims at most one credential action/target, and completion cannot switch operator, phone, station, member, action, or pending credential.
- Every published attendance session freezes an expected participant set and preserves its plan/version.
- Overlapping sessions store independent `sessionAttendance` state; one session transition cannot overwrite another.
- A session cannot open before its expectation job completes or reach closed before finalization/checksum verification.
- Enrolled VIT ID barcodes, static external event passes, and optional external-badge QRs converge on one participant-scoped scanner command. A staffed missing/incorrect-transition remedy uses the separately authorized reconciliation command but writes the same presence ledger and projections.
- A VIT ID's raw barcode value is never stored and maps through an event-scoped keyed fingerprint only after staffed enrollment. An external badge contains no personal data and is stored only as a hash.
- One VIT ID barcode fingerprint cannot bind to two active event memberships; suspension/rebinding takes effect on the next online scan.
- Simultaneous, repeated, stale, and replayed scans cannot open duplicate intervals or increment totals twice.
- A temporary exit and return preserve separate intervals and update participant, team, zone, session, and roll-call projections together.
- Extension, early/late close, and cancellation serialize on the current session version and cannot edit the scan ledger; a late close is capped at the accepted end, while cancellation reaches terminal state only after its no-absence batch.
- A live presence correction is a linked compensating event with actor/reason and the exact prior projection version, never an edited source event. It cannot commit once session close begins.
- A finalized-result remedy has one open case, separate self/read/open/decide grants, an exact frozen before snapshot, an audited participant-facing outcome, and optimistic versions. Approval changes only the derived participant result and its counter shard; decline changes neither, and neither path rewrites event or interval history.
- An emergency roll call uses one prepared session cohort, has separate exact-session read/start/close grants, preserves one starting snapshot/checksum, permits one active record per zone, keeps sharded live counts equal to expected, and freezes final counts against later scans.
- An identifiable attendance export uses one prepared session and one consistent query, enforces its cohort/field/expiry bounds, owns the file to its requester, protects it with a private checksum manifest and short signed URL, and never includes bearer or exact movement evidence.
- An emergency pack contains accepted participants only, uses one bounded consistent snapshot, has one collision-checked serial namespace, source/document checksums, exact-version private storage, a four-hour life, and separately enforced prepare/read/print grants.
- Pack metadata reveals no roster, serial prefix, storage coordinate, or print URL. A print-open requires current authorization, is audited before URL delivery, cannot outlive pack expiry, and changes no incident/manual-mode state.
- Manual attendance mode requires two different incident approvals. Paper entry, protected-source read, and independent verification are separate exact-session permissions, and the entrant cannot verify their own sheet.
- A submitted paper sheet has immutable resolved rows and source checksum, imports each line at most once through the ordinary transition engine, preserves newer evidence as authoritative, and blocks session close/incident resolution until decided.
- A paper review is limited to an existing active review, freezes the exact panel/rubric/evidence/assignment/scorecard context, requires every signed reviewer and assigned criterion, and uses separate exact-review read, enter, protected-source, and verify permissions.
- A different verifier imports every paper scorecard or none. Imported versions name the signed reviewers and manual record, feed the ordinary evaluation, mark the review visibly as a paper import, and block ordinary score writes, review completion, incident resolution, and round close while pending.
- No participant permission can create or change a team/round state. Exact-panel `queue.manage` creates a queue row directly, and its absent-state/version check serializes concurrent placements.
- Operations health, intelligence read, and intelligence generation are separate grants. The generated result exposes no frozen snapshot or domain-control token, and generation creates no corrective state.
- One brief freezes one bounded redacted source/checksum, maps to one create-only durable agent instance, and has one terminal settlement. Every priority cites only frozen signal keys and preserves a cited highest severity, owner, and next action.
- A stale, invalid, late, duplicate, or competing Worker callback cannot change a settled brief. Loss of the intelligence Worker changes no participant, application, attendance, queue, review, score, incident, access, or Synesthesia record.
- Operations-autonomy-policy read, draft, validation, and publication are independent event grants. Publication replaces the published policy and scheduler state atomically and requires the exact draft checksum, current event version, recent Google session, reason, and idempotent operation ID.
- Concurrent evaluation coalesces only an exact duplicate. Distinct signal episodes, schedule slots, and manual requests remain in a durable inbox while one event executor works, and fair draining prevents another busy event from starving them.
- Autonomous reads exhaust every page of the closed allowlist through durable continuation. Provider/request/prompt bounds constrain one batch only; they do not impose a total turn, delegation, evidence, runtime, proposal, or history cap.
- Every autonomous recommendation references a sealed, hash-chained, cursor-pageable set of exact completed read-operation leaves and traversal snapshots. A repeated still-open effect preserves every later run as a separately sealed observation while keeping one human command. All pending decisions, settled decisions, observations, evidence leaves, runs, and queued work remain cursor-pageable from the operations dashboard.
- The agent can observe and record typed proposals only. Access, identity, participant, judging, score, notification, money, release, and other materially consequential effects require the ordinary authorized human command with current target versions.
- Kill, policy supersession, owner revocation, and event closure revoke authority immediately and drive a durable idempotent Worker abort until acknowledged.
- A participant queue estimate is absent outside a queued state or during a round pause, uses configured duration before three valid panel samples, and remains a widened five-minute window rather than an appointment. Its absolute bounds age from a server-time anchor between database changes, even when the participant device clock is wrong; an expired upper bound is labeled as taking longer instead of preserving a stale minute count.
- Participant attendance and review-presence QR countdowns use the server time returned by the mint command. Device clock skew cannot extend or prematurely hide the displayed credential. Each surface subscribes to the displayed token's exact owner-checked state and stops showing it immediately after use, replacement, revocation, or supersession.
- Participant provisioning and approved roster claim create independently revocable self support create/read/reply grants. Revoking one is effective immediately, reusing the subject never silently recreates it, and invitation-only account creation remains grantless.
- A reporter can create, list, open, and reply to only their own support cases; internal notes and ownership actions are absent from that view. A closed case rejects reporter replies.
- Exact-case and event-wide support read/manage grants remain distinct. An owner, role label, linked team/review/session, or self create grant cannot substitute for either one.
- A support retry creates one case or timeline action. Two concurrent case updates cannot cross the optimistic version, every staff update has an audit reason, and timeline actions are never edited in place.
- Support state and public replies converge across authorized participant, event-app, and operations views, while no support command can change attendance, queue, admission, team, integration evidence, review, score, or access records.
- A round-wide pause requires a readable active review-backend incident plus independent exact-round `review.round.pause`; resuming requires independent exact-round `review.round.resume`. Both use current authorization, reasons, stable operation IDs, and current versions.
- One round has at most one active pause. While it exists, queue placement and already-started review work continue, but a new team call, new review start, round close, and linked incident resolution fail transactionally.
- Review call and start use the team projection updated atomically by current venue presence, rather than staffed-arrival or team-status milestones. A below-minimum call/start needs one immutable exception authorized for the exact team/review with current authorization; that exception changes no attendance or score state and cannot carry to another review.
- Participant and reviewer projections expose only generic pause state. Incident title, summary, and pause reason require the caller's separate `incident.read` grant for the exact incident.
- Attendance cannot alter admission, project, integration evidence, rubric, scorecard, or evaluation records.
- One team and one panel cannot enter two active review sessions.
- One reviewer cannot occupy overlapping active seats.
- One reviewer/session produces one scorecard with immutable submitted versions.
- Every complete evaluation result names the exact immutable scorecard versions used.
- Round close cannot race past an active incident pause, required scorecard, live review, unresolved correction, pending paper record, or team without one explicit result/exclusion/withdrawal entry.
- No ordinary mutation changes a review round directly from `open` to `closed`; only independent verification of an uploaded exact-version export closes it.
- The export recomputes the selected result from its immutable scorecard-version IDs and fixed formula, and count/checksum/object-version disagreement leaves the round in `closing`.
- Starting, reading, retrying, verifying, and reopening use separate exact-round permissions. The starter cannot verify their own export even if another grant source gives them the verify key.
- Reopen never edits or deletes a verified snapshot/file manifest, and a later close has a higher revision.
- Live participant, reviewer, and operations views derive from the same operational records.
- A provider resource cannot be active for two teams in one event without an audited override.
- One team can hold several active GitHub repository bindings, including bindings from different App installations.
- Every active repository has a kind, purpose, branch/root, baseline, independent status, metrics, and snapshots.
- Replacing the member who authorized Figma does not change the team that owns the file evidence.
- Duplicate GitHub/Figma provider events cannot increment a fact or metric twice.
- Every accepted Figma connection, file, metadata, full-sync, preview, and webhook transition leaves exactly one current team summary consistent with its visible file metrics/snapshots/previews; a 30-team operations list does not load those child rows until one team is expanded.
- Every new Figma snapshot creates at most one preview set and its complete bounded candidate facts in the snapshot transaction; no caller can create a raw snapshot through another write seam.
- Every new full Figma snapshot also creates one activity manifest plus its bounded named-version and comment facts in that transaction; counts, display order, ownership, and completeness must agree before reviewer display.
- Figma renders name the snapshot's exact provider version. A late or duplicate worker cannot attach results after its lease changes, and a terminal preview set has exactly `availableCount + failedCount = selectedNodeCount` with no pending fact.
- Only the current metadata lease can commit a provider check. Provider last-touched time wins first and server observation time breaks ties, so a late metadata or full-content response cannot replace a newer observation. A version observed ahead of the full-content version marks the binding dirty without presenting that version as captured evidence.
- The 15-second scheduler dispatches at most 64 due metadata actions per pass. A check leases one file for 90 seconds; a job that never starts becomes eligible again after five minutes. Every `429` stores and obeys Figma's `Retry-After` for the affected Tier 3 metadata or Tier 1/2 capture path without incorrectly freezing the other tier.
- A reviewer preview URL resolves only from an available fact inside the exact Figma snapshot pinned by that assigned review; object keys and provider render URLs never appear in a query or client argument.
- A reviewer layer page resolves only after the immutable Figma artifact's compressed size, decoded size, checksum, and internal provider version match its pinned manifest; direct children paginate without a live Figma request.
- A reviewer activity query returns only facts owned by the exact pinned snapshot and distinguishes a complete capture from a bounded or pagination-limited one.
- A review checkpoint comparison follows `previousCheckpointSetId`, not `figmaFileSnapshots.previousSnapshotId`; an intervening provider refresh cannot become the judging baseline.
- When the current or earlier 48-frame selection is truncated or missing, an unmatched frame is uncertain rather than asserted added or removed. A preview URL still resolves only from an available fact owned by that exact side's pinned snapshot and preview set.
- A review session keeps its original evidence-checkpoint-set ID when repository membership, classification, order, or snapshots change.
- Combined GitHub metrics deduplicate exact observed commit SHAs across repositories, expose the overlap, and label bounded or project-root identity coverage partial instead of silently double-counting, omitting, or fabricating an exact total.
- Provider credentials never appear in project, snapshot, job, query, audit, or error payloads.
- A round export preserves every relation for each adjudicated outcome needed to reproduce totals and selected-review exception history; the separate Convex backup preserves unrelated canceled attempts and the rest of the database, and its staging restore is rehearsed independently.
- A backup success requires file storage, safe unique ZIP paths, valid JSONL, immutable KMS/versioned S3 objects, local and S3 checksum/size agreement, and a versioned manifest. A restore-rehearsal pass additionally requires an exact repeated staging target, a pre-restore backup, exact-version download verification, destructive import confined to staging, and an equal full re-export inventory.

## Event-review operations additions

`reviewerPoolEntries` preserves imported declarations without accepting the broken form hours. `reviewerRoundConfirmations`, `reviewConfirmationRequests` and `reviewConfirmationNotifications` own versioned actual availability, opening and native shift reminders. Panel profiles/seat assignments carry Board/SC/JC composition, and published rounds carry the staffing policy. Completed assignments drive JC participation fairness.

`reviewQueuePolicies` configures routing, next-team call-up, heads-up timing, score-entry allowance and consented voice calls. `reviewQueuePanelChecks` records current blockers, and `reviewTeamNotices` binds every notice to one queue-state version. Reassignment or a hold invalidates an obsolete notice/call.

`reviewQuestionPolicies` configures preparation. Each `reviewQuestionSets` row contains one source/policy checksum, frozen evidence manifest, bounded redacted request, leased attempt and immutable result. `reviewSessions.questionSetId` pins the context selected at actual start. Suggested questions cannot write any score field. The review lifecycle uses `active` for discussion and `scoring` afterwards. Every required final comment follows its scorecard through immutable versions, corrections, paper recovery and exports.

`reviewAggregationPolicies` versions the closed-round combination (default 30%/70%). Missing or excluded inputs prevent a complete cumulative total instead of becoming zero.


## Comprehensive review preparation and venue call responses

`reviewQuestionCollections` holds resumable per-resource inventory/offset/lease state. Private storage contains complete inventory or normalized Figma manifests. `reviewQuestionParts` stores bounded source batches, original citations, immutable model findings, attempts and reusable content keys. Pairwise synthesis combines all completed batches; the final question set only enters generation after collection and complete chunk accounting. The question set carries coverage and a source-check timestamp independent from work progress. Failed/expired work does not silently become a complete brief.

Venue presence carries tracking generation and its authoritative start time. Both the phone and backend reject pre-generation location fixes. `outboundCallDeliveries` pins the selected conversational agent, response expiry and current departure. Structured answers and transcripts are stored with immutable provider events; deliveries expose the recorded response and its effect (`confirmed`, `clocked_out`, `needs_ops`, `stale`). Convex checks current consent, departure, tracking authority, policy and active/scoring assignments before applying a result. Read access is limited to authorized event reviewer-profile readers. GPS never clocks out a reviewer. Call completion alone never confirms availability. Existing app clock-in cancels an older unresolved venue check.

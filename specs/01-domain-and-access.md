# Identity and access

## 1. Authentication choice

Code2Create uses Better Auth with Google for every VIT student and with a
six-digit email OTP as an additional sign-in method for external participants.

Better Auth runs inside the Convex deployment through `@convex-dev/better-auth`, which is maintained by Convex. The auth component owns provider accounts, sessions, verification records, and cookies. Application tables own event membership, participant class, teams, reviewer profiles, role labels, and atomic permission grants.

There is no Clerk tenant, participant password, magic link, or role stored in
an unverified client claim. Better Auth stores only a hash of each email OTP,
limits attempts and requests, expires it after ten minutes, and consumes it on
successful sign-in.

## 2. Participant sign-in

The first screen has two choices:

1. **VIT Student**
2. **External Participant**

VIT students continue with Google. External participants can continue with
Google or paste a non-VIT email address and enter the code delivered to it.

### Participant-type selection

The browser keeps the choice only for the current sign-in tab. If the choice is
missing after authentication, the portal asks for it again before provisioning.

This choice improves the sign-in instructions. It grants no authority and does
not decide the stored participant class. Better Auth owns OAuth state, validates
the Google callback, and atomically verifies email OTPs. The provisioning
mutation identifies the event from its server-loaded slug and derives the
participant class from the verified identity. Editing browser storage or a
return URL cannot create a VIT membership.

### Server classification

After authentication, the server reads the verified email plus the Better Auth
user and session IDs. For Google accounts it additionally reads:

- Google provider subject (`sub`);
- hosted-domain claim (`hd`), when present;

The server applies these rules:

| Selected path | Verified result                                   | Outcome                                                                                     |
| ------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| VIT Student   | `hd` matches an approved VIT student domain       | Create or resume a `vit_student` event membership                                           |
| VIT Student   | `hd` missing or not approved                      | Stop provisioning; explain that the VIT account is required and offer a restart as External |
| External      | `hd` matches an approved VIT student domain       | Classify as `vit_student`; the selector cannot bypass VIT classification                    |
| External      | verified Google account with no approved VIT `hd` | Create or resume an `external` event membership                                             |
| External      | verified email OTP with no Google `hd`            | Create or resume an `external` event membership                                             |
| External      | VIT-domain email OTP without a Google `hd`        | Stop provisioning and require Google Workspace sign-in                                      |

Successful provisioning also creates or resumes the person’s event access subject. This is the common security boundary used by participants, rostered users, and explicitly invited accounts.

The initial approved domain is `vitstudent.ac.in`. VIT IT must confirm the final list before production opens.

Email suffix matching is not enough for VIT membership. Google documents `sub`
as the stable user identifier and `hd` as the claim to check for
Workspace-domain membership. The Google subject is stored when present; the
Better Auth user is the account key and email remains a verified contact and
roster-matching value.

## 3. Reviewer and staff sign-in

Reviewer and staff routes do not show the VIT/External selector.
Email OTP sessions cannot bootstrap, claim, or enter operations access; those
flows continue to require a verified Google identity.

Before the event, an operator with event-scoped `access.roster.import` uploads one UTF-8 CSV whose exact headers are `email,name,role`. A logical row contains the verified Google email expected at claim, the person's display name, and one organizational label: `supreme`, `board`, `sc`, `jc`, or `external_judge`. The browser accepts at most 256 KB and the server accepts at most 200 non-empty rows per import. It rejects malformed addresses, duplicate normalized emails, duplicate/invalid source row numbers, unknown roles, and extra columns.

The operator also supplies a source name, the source filename when present, an audited reason, one shared access-validity window, and up to eight optional current published permission-bundle versions. The event end must already be configured, the window must end in the future, and it cannot outlive the event. A roster bundle may contain event scope, target-person scope, or reviewer-device self scope. A bundle that needs a participant membership or a named resource binding is excluded; panels, stations, rounds, and other resource assignments happen through their own scoped workflows.

Preview is read-only. It pins the validity window and bundle content checksums, then classifies every row as new, replacement for a pending/expired row, unchanged pending, or already claimed. Confirmation recomputes that preview, requires a current scoped authorization, and writes one immutable import plus its new pending rows in one idempotent Convex mutation. Replaced pending rows become `superseded` or `expired`; unchanged pending and already-claimed rows are not rewritten. A later import can never silently alter a claimed person's role or grants.

After Google sign-in, the exact matching verified account sees a short claim screen. Claiming:

1. reloads the pending row, its import, pinned bundle checksums, event, version, and claim window;
2. links the row to the Better Auth user and Google provider subject;
3. creates or reuses the active event access subject;
4. creates the organizational role assignment unless the same label already exists, and stops on a conflicting active label;
5. materializes the code-owned role template when one exists, then expands only the pinned compatible bundle versions into separately inspectable person-specific grants with the roster validity window;
6. marks the row claimed and records the role, grant batches, identity link, operation, and audit event atomically;
7. uses the linked person on later sign-ins instead of repeating an email match.

The account may claim before the grants' `validFrom`; those grants remain ineffective until server time reaches the window. The pending row itself cannot be claimed after `validUntil`. An exact operation retry returns the prior result. Concurrent claim, revoke, replacement, or expiry produces one winner through the row version and Convex transaction conflict detection.

A participant may also be rostered staff or an External Judge. The user keeps one account. Participant/team access and manually granted event permissions coexist on that person without changing the role label. An External Judge can use any verified Google account if that address is on the roster.

Roster normalization trims whitespace and lowercases the address for lookup. It does not remove `+tags`, dots, or apply provider-specific alias rules.

An unmatched account receives no staff data. A pending row can be revoked before claim by `access.roster.revoke` scoped to that exact row or the event; this requires current scoped authorization and a reason. Correcting a pending name, role, email, window, or bundle set means previewing and confirming another import. Correcting a claimed identity or role uses the separately authorized identity-repair or role workflow.

The first permission administrators are part of the reviewed production seed. The seed materializes the Supreme role template as atomic grants, including event-scoped `access.permissions.read`, `access.permissions.grant_any`, `access.permissions.revoke_any`, and `access.subjects.invite`. Protected functions authorize those grants rather than the word `supreme`. No dashboard command can create the first grant-any or revoke-any authority because assigning Supreme requires the assigner to hold grant-any already. A later holder may grant either permission to another event-linked person through the ordinary audited path.

An event-scoped `access.subjects.invite` holder can create a pending invitation for one exact normalized Google email without browsing the global account directory. The claim window is explicit and must be between five minutes and 30 days. Creation and revocation require a current scoped authorization plus a reason.

After Google sign-in, the matching verified account sees one claim screen. Claiming atomically creates or reuses the person and active event access subject, marks the invitation claimed, and records the identity-authorized change. It assigns no role and no permission. A separate grant administrator can then give that role-less account one exact capability. Claim, revoke, scheduled expiry, and duplicate create attempts are versioned and idempotent; only one transition can win. Subject suspension and reactivation are separate commands and never happen through invitation claim.

The deployed account-lifecycle commands require independent `access.subjects.suspend` or `access.subjects.reactivate` authority for the exact target person. An explicit event-wide grant can also satisfy this requirement. The commands also require the current `accessVersion`, a reason, and a current scoped authorization. Suspension immediately denies every grant without rewriting it. Reactivation restores the subject boundary. Only grant rows that remain active and unexpired work again. Revoked or expired grants never return. A user cannot suspend their own event account. Another authorized administrator must perform that action.

## 4. Account records

| Record                           | Owner                                            | Purpose                                                                                                                                        |
| -------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Better Auth user/account/session | Better Auth component                            | Google identity link and session lifecycle                                                                                                     |
| Person                           | Application                                      | Display name, verified contact, status, and auth-user reference                                                                                |
| Event access subject             | Application                                      | Active/suspended event security boundary and monotonic access version for any event-linked person                                              |
| Event access invitation          | Application                                      | Expiring exact-email authorization to create or reuse one role-less event access subject on Google claim                                       |
| Event membership                 | Application                                      | Participant class and event participation state                                                                                                |
| Event role                       | Application                                      | Organizational Supreme, Board, SC, JC, or External Judge label; never an authorization decision by itself                                      |
| Permission grant                 | Application                                      | One atomic permission for one person, one event/resource scope, and one validity window                                                        |
| Permission bundle                | Application                                      | Versioned convenience template expanded into atomic grants                                                                                     |
| Permission grant batch           | Application                                      | One audited manual, roster, membership, assignment, or bundle operation that created/revoked grants                                            |
| Roster entry                     | Application                                      | Approved reviewer/staff invitation and first-sign-in claim                                                                                     |
| Device                           | Application                                      | Reviewer/scanner installation, app version, hardware capabilities, station assignment, notification token, and revocation state                |
| Attendance credential            | Application                                      | Event-scoped VIT and external physical-ID barcode fingerprints, optional external badge QR, and one encrypted static external event pass; raw barcode values/bearers are not stored |
| Support case                     | Reporter plus separately scoped event operations | Diagnostic context and append-only actions; ownership or a linked resource grants no authority                                                 |
| Provider authorization           | Application security boundary                    | One encrypted Figma App/user grant or GitHub App installation reference used only by server jobs                                               |
| Team integration                 | Team                                             | Selected provider resources, repository classifications, checkpoint sets, statistics, and review visibility                                    |

The application does not copy session secrets or raw Google access tokens into its domain tables. Provider authorizations grant API access, but they do not own the connected repository set, Figma file, or captured evidence.

## 5. Roles, permission grants, and bundles

The event keeps five organizational labels:

| Role           | Suggested default permission template                                                                           |
| -------------- | --------------------------------------------------------------------------------------------------------------- |
| Supreme        | Permission administration and broad event-governance defaults                                                   |
| Board          | Policy, admissions, rubric, results, correction, export, and override defaults                                  |
| SC             | Workflow-management defaults for selected operational scopes                                                    |
| JC             | Frontline execution defaults for selected station, queue, support, verification, or playback scopes             |
| External Judge | Assigned-panel context, presence, and own-scorecard defaults                                                    |

Roles exist for roster grouping, display, sensible starting bundles, and training. A protected Convex function never authorizes from the role string. A role assignment may atomically materialize a code-owned template as ordinary source-attributed grants; the deployed Supreme template contains every event-wide catalog permission plus its own self-scoped permissions. There is no ceiling on permissions a target may hold based on their role.

Any authenticated person linked to the event may receive any permission regardless of role, including a participant or External Judge. The grant must name:

- one stable permission key from the server-owned permission catalog;
- the exact subject person and event;
- an exact scope type and scope ID, or an intentional event-wide scope;
- `validFrom` and `validUntil`;
- optional catalog-defined constraints such as device, station, own-record-only, or current authorization requirement;
- source, grantor, reason, and grant batch.

Permission keys are atomic. Examples include:

- `event.lifecycle.read`
- `event.lifecycle.manage`
- `access.permissions.read`
- `access.permissions.grant_any`
- `access.permissions.revoke_any`
- `access.permissions.grant_scoped`
- `access.permissions.revoke_scoped`
- `access.roles.assign`
- `access.roster.import`
- `access.subjects.invite`
- `access.subjects.suspend`
- `access.subjects.reactivate`
- `access.permission_bundles.read`
- `access.permission_bundles.publish`
- `access.permission_bundles.apply`
- `access.permission_bundles.migrate`
- `configuration.participant.read`
- `configuration.participant.draft.create`
- `configuration.participant.validate`
- `configuration.participant.publish`
- `configuration.admission.read`
- `configuration.admission.draft.create`
- `configuration.admission.validate`
- `configuration.admission.publish`
- `configuration.integration.read`
- `configuration.integration.draft.create`
- `configuration.integration.validate`
- `configuration.integration.publish`
- `attendance.scan.execute`
- `attendance.presence.reconcile`
- `attendance.remedy.read`
- `attendance.remedy.open`
- `attendance.remedy.decide`
- `attendance.roll_call.read`
- `attendance.roll_call.start`
- `attendance.roll_call.close`
- `attendance.export.identifiable`
- `support.case.create`
- `support.case.read`
- `support.case.reply`
- `support.case.manage`
- `rehearsal.read`
- `rehearsal.manage`
- `rehearsal.execute`
- `rehearsal.complete`
- `review.scorecard.submit`
- `review.participant_availability.waive`
- `review.presence.waive`
- `communications.call.dispatch`
- `communications.call.read`
- `round.close`
- `round.export.read`
- `round.export.verify`
- `round.export.retry`
- `round.reopen`

There is no `admin`, `all`, or `*` permission checked by application functions. Event-wide scope is explicit and visible; it is not inferred from Supreme or Board.

### Arbitrary per-user grants

A person with event-scoped `access.permissions.grant_any` can grant any catalog permission to any event-linked person at any time, regardless of either person’s role. Event-scoped `access.permissions.revoke_any` independently allows revocation. Holding one never implies the other. The direct permission screen requires the actor to choose the permission, scope, optional expiry, constraints, and reason. Roster imports separately provide a shared start/end window for the grants they create.

The same screen can add or remove several exact grants for one person. The command accepts one to twenty unique entries; the batch control uses it only when at least two entries are selected. All adds share one optional expiry and reason. All removes share one reason. The server resolves every resource and checks every grant or revoke ceiling before writing. One illegal entry, stale target version, old session, or mixed unrestricted/delegated authority rejects the complete change. A successful change advances the target's `accessVersion` once and stores one operation result and one audit record with the exact grant list. Direct batches create ordinary individually revocable grants. They do not create a permission-bundle application record.

Each event-scoped `access.permissions.grant_scoped` row carries one non-administrative permission key, one exact legal resource scope, an exact active target person or the explicit `any_event_person` boundary, and a required expiry. The row's expiry is both the lifetime of the delegation and the latest expiry it may issue. `access.permissions.revoke_scoped` is a separate row with the same key/resource/target boundary and its own lifetime. Several rows are required for several keys or resources. Target-owned self, reviewer-page, and reviewer-owned scorecard scopes require one exact target; they cannot use `any_event_person`. A scoped grant delegator cannot act on themselves, cross events, omit or change the resource, act on an excluded target, issue a grant without an expiry, exceed the ceiling, or manufacture broader delegation.

Grant authority is not execution authority. A person who can grant `round.close` but does not hold it cannot start the close or export. A person who starts it still cannot download, verify, retry, or reopen without each separate key. Scoped grant or revoke authority cannot create or revoke `access.permissions.grant_any`, `access.permissions.revoke_any`, `access.permissions.grant_scoped`, or `access.permissions.revoke_scoped`. Those rows require unrestricted grant or revoke authority. Scoped authority is created only as an explicit person-specific grant. A convenience bundle cannot create it.

Access administration is decomposed like every other area. Looking up event people, reading another person’s grants, assigning a role label, importing a roster, publishing a permission bundle, applying a bundle, migrating existing bundle-sourced grants, granting, and revoking use separate keys. A person may hold any subset. For example, `access.permission_bundles.apply` can be scoped to one bundle and constrained to named targets without permitting bundle editing, role changes, or direct manual grants.

Applying a versioned operational bundle remains a separate shortcut and creates `permissionGrants` rows tied to one `permissionGrantBatch`. Role assignment instead applies the selected role's code-owned template in the same mutation and attributes those grants to the role row. It never applies or migrates a versioned bundle. Editing a bundle later changes nobody until a previewed migration or new grant/revoke batch runs.

The deployed bundle manager keeps one stable bundle identity. It has at most one editable draft and one current published version. Draft saves use the current bundle version and draft revision. Publication validates every entry against the code-owned catalog. It retires the prior published version and records the content checksum and diff. It requires exact bundle read and publish authority. It also requires a current scoped authorization. Published versions are immutable.

Application is separately authorized. The caller must be able to read the exact target person's access. The caller must also be able to read and apply the exact bundle to that person. An explicit event-wide grant can satisfy each boundary. The preview resolves every `event`, bundle-target, or named-resource binding on the server. It proves that each resource belongs to the event. It applies the requested expiry and binds the result to the target's current `accessVersion`. Confirmation requires a current scoped authorization. One mutation creates all missing source-attributed grants and one completed grant batch, or it creates nothing. An exact retry returns the first result. A different resource binding or expiry has distinct provenance. Existing grants from another source appear as coverage. The bundle does not rewrite or adopt them.

Publishing a new version remains non-retroactive. The deployed migration flow selects one retired version and one to five completed application batches from that version, then compares them with the current published version of the same stable bundle. The caller needs bundle read and migrate authority for the exact bundle plus access read and migrate authority for every exact target person. Apply, publish, direct grant, direct revoke, role, and roster authority are not implied.

The server resolves destination bindings again, suggests an old binding only when the binding key and resource type still match, and preserves each source application's expiry subject to the current event end. Preview identifies every add, replacement, removal, already-current grant, and preserved exception. Confirmation rechecks the immutable version checksums, exact source batches and grant states, target `accessVersion` values, destination-source history, bindings, and actor authority. One authorized, idempotent Convex mutation either migrates all selected targets or none. It supersedes only current grants attributed to those selected old applications. Manual grants, grants from another bundle application, and permissions explicitly revoked in either the old application or an existing application of the destination version are never silently restored or removed.

The deployed role command accepts only Supreme, Board, SC, JC, External Judge, or no role. It requires `access.roles.assign` for the exact target person (or an explicit event-wide grant), the target's current `accessVersion`, a fresh current authorization, and a reason. Before writing, the backend expands the selected role template and validates every planned grant against the assigner's grant ceiling. Replacing or removing a templated role likewise validates every planned removal against the revoke ceiling. The transaction ends the prior role row, revokes only that row's `role_template` grants, writes a new active row when a role remains, materializes the new template grants, and advances access once. Supreme is the only deployed role with an automatic code-owned template; the other labels continue to use explicit bundles or grants.

Team membership, team lead, panel assignment, scanner-station assignment, incident command, and release ownership use the same model. Each assignment materializes narrowly scoped permissions. When the assignment ends, it revokes only the active or scheduled grants from that assignment. Creating one logical grant group advances the affected person’s `accessVersion` once, and only when the operation added at least one row. An exact retry that finds every row does not change the version. Source teardown follows the same rule for revocation.

A grant whose `validFrom` is in the future is stored as `scheduled`. Creation schedules exact start and end transitions. A bounded 15-second sweep repairs missed work through lifecycle indexes and immediately continues when a batch has more rows. Every transition reloads the grant inside the mutation; a revoked or superseded row is a no-op and can never be revived by a stale job. Expiry remains enforced from server time on every protected call even before its history row is materialized.

No shared Supreme or Board account is permitted. A role, grant, or seniority does not permit a user to edit another person’s submitted scorecard. It does not permit a user to bypass a conflict, state, or device check. It does not permit changes to captured evidence. Each exception requires a separate explicit override permission for that exact action and scope.

### Capability checks

Each public Convex function checks:

1. a valid Better Auth identity;
2. active person and event access-subject records;
3. the exact stable permission key required by the function;
4. at least one active, unexpired grant for that person and permission;
5. exact event and resource-scope containment;
6. catalog-defined grant constraints;
7. active membership or assignment where the domain action requires it;
8. the current object state and expected version;
9. conflict-of-interest, fresh-session, device, and station requirements.

The role label is not part of this decision. The web route guard and cached client bootstrap improve navigation only; neither replaces the permission lookup inside Convex.

Each permission definition states whether an ancestor grant can cover a child resource. The backend proves containment by loading indexed records. For example, the backend verifies that a panel belongs to the granted round. The backend never trusts an ID prefix or client claim. Sensitive keys can forbid event-wide or ancestor scope and require the exact leaf record. The backend never converts a grant for one resource type into a grant for another type.

## 6. Data visibility

### Participant and team grants

Participant provisioning materializes self-scoped permissions for the participant's profile, attendance status, dynamic QR, finalized-result review status, and event configuration. Joining a team materializes team-scoped read permissions for its roster, proposal, integrations, staff-managed queue, review progress. Team-lead assignment adds only team management, accepted transfer, exact-team `application.submit`, and offer response. Final submission does not revoke ordinary join, leave, remove, or lead-transfer grants. The server state-blocks those commands at the deadline for the team's participant class. A successful post-submission team change atomically advances the immutable application snapshot and invalidates stale review and AI output. No participant or team-lead grant can place a team into a review round or panel queue.

Those grants never include another team’s private submission, unreleased judge identity, score, panel note, conflict, or another participant’s detailed presence history. Leaving or being removed from a team revokes the grants sourced from that team membership without touching unrelated manual grants.

### Application-review grants

`application.assign` routes one application to an exact active event account. The transaction creates a separate `admissionReviewAssignments` row and source-attributed exact-application `application.review.read` and `application.review` grants. It does not use the target's role. Canceling pending work revokes only those assignment-sourced grants; an independent manual grant remains active. Completion changes the routing row to `completed` and preserves its read/write grants so the reviewer can inspect the resulting record. A person who receives the same exact grants manually can review without an assignment.

Assignment-scoped read exposes the current immutable proposal version, approved source answers, fresh-project attestation, permitted team fields, and the caller's own recommendation. Peer recommendations remain hidden until that caller submits a current-version recommendation. `application.profile_context.read` separately exposes participant class, year and institution context, the deterministic experience band, and its guidance. `application.ai_recommendation.read` separately exposes the structured AI record. Neither permission follows from assignment.

The deployed admissions boundary uses `application.read`, `application.review.read`, `application.review`, `application.assign`, `application.profile_context.read`, `application.ai_recommendation.read`, `application.ai_recommendation.run`, `application.decide`, and `application.offer.manage`. Each key accepts exact-application scope or an explicit event scope. The current lead separately receives exact-team `application.submit` and `application.offer.respond`.

`application.ai_recommendation.read` reveals the structured result. It does not permit a retry. `application.ai_recommendation.run` permits a reasoned retry of the current analysis only while the application is in active human review and that analysis has a definite failed or stale terminal state. It does not reveal the result. The command checks the expected application version and current recommendation ID, keeps the old record, creates one new policy-pinned recommendation, and records the operation and audit event. A repeated operation returns the same new recommendation. Pending, running, successful, disabled, superseded, decided, and offer-stage records cannot be retried.

Submitting cannot edit the roster. Responding to an offer cannot manage it. Reading or retrying analysis cannot publish a decision. Publishing a decision does not reserve capacity. Sending or revoking an offer cannot impersonate the team's response. None of these grants implies access to contact, eligibility, or judging data. Waitlist promotion stays out of the code-owned catalog until O-023 defines its ordering rule and the protected command ships.

### Judging grants

A panel or review assignment materializes only the permissions needed for that judge and review: page response, assigned proposal context, the frozen evidence checkpoint, released previous findings and commitments, presence, and the caller's own scorecard. The permissions are scoped to the round, panel, review session, and person. A synthesized fallback call inherits the exact `review.substitute.page` grants frozen on the page chain. It never uses the reviewer's page-response grant. Current reviewer call consent is also required. Consent never creates a permission.

The ordinary assignment bundle does not include peer score values, unrelated teams, hidden participant data, staff audit history, or another judge’s scorecard. Although External Judge is the normal role label, the same exact grants can be issued manually to another role when required.

### Operations grants

Operations screens are assembled from granular read permissions. `event.lifecycle.read` reveals only the current state and legal next transitions. `event.lifecycle.manage` changes the event state but does not reveal it by itself. A station grant may expose only the identity/current state needed to scan at that station; it cannot record staffed arrival. `attendance.venue_check_in.read`, `.record`, `.override_identity`, and `.reverse` are independent person-scoped keys with an explicit event-wide option. The identity exception and reversal additionally require current authorization and a reason. `review.participant_availability.waive` resolves only for the exact team or pending review (or an explicit event-wide grant), requires current authorization and a reason, and changes no attendance state. Another grant may expose panel completeness without score values; another may expose one integration’s health. Support create, read, reply, and manage are independent: self grants cover only cases reported by that person, while staff read/manage use the exact `support_case` or explicit event scope. Rehearsal read, management, scenario execution, and final completion are independent exact-`rehearsal_run` or explicit event grants. Workstream ownership routes responsibility but creates no grant. Assigning a support owner likewise creates no grant. Reading a closed-session result remedy, opening one, and deciding one are three independent exact-session permissions. An open/decide grant alone does not reveal the roster or evidence. Exact movement history, sensitive exceptions, emergency roll call, score values, identifiable exports, and the emergency pack each require separate permissions and scopes. `emergency_pack.prepare`, `.read`, and `.print` are independent event-scoped keys; preparing does not reveal another pack, reading cannot mint a print URL, and printing grants no incident/manual-mode command. `operations.intelligence.read` returns only the latest validated event brief, while `operations.intelligence.generate` can request one from the frozen aggregate health projection. Neither implies the other, `operations.health.read`, a drill-down permission, or any corrective command. No permission exposes raw provider tokens, VIT ID barcode values/fingerprints, session cookies, QR bearers, or internal support notes outside a covered case.

## 7. Sessions and devices

- Better Auth sessions expire after seven days and can refresh after twelve hours of activity. Every protected command relies on the active signed-in identity and rechecks its exact current grants and scopes when it runs.
- Permission grants have explicit validity windows and cannot outlive the configured event/access ceiling.
- Revoking a permission affects the next protected backend call even if the Google session and role label remain valid.
- Changing a templated role atomically revokes the prior role row's source grants and applies the new role template only within the actor's separate grant and revoke ceilings. Independent manual, bundle, and assignment grants remain unchanged.
- Web sessions use secure, HTTP-only, same-site cookies.
- The Expo Better Auth client stores session cookies in `expo-secure-store`.
- The Expo app registers one device record with platform, build number, camera capability, notification token, last-seen time, and revocation state.
- The reviewer app and attendance scanning reject a revoked device or an app below the configured minimum build.
- A scanner must also have an active station assignment whose event, mode, zone, direction, and validity match the command.
- Any later override, after-deadline correction, migration, direct permission batch, or raw export uses the same 15-minute fresh-session boundary unless the published security policy makes it stricter. On the web, an older session opens the hosted Google verification popup on the current page. The client retries the exact operation ID only after Convex confirms the new session is fresh.

The exact session settings live in security configuration and must be tested on real web and mobile builds.

## 8. Identity changes and duplicates

- Accounts are never merged only because two Google identities share an email.
- If a provider subject changes or a rostered email was wrong, a caller with `identity.repair.open` for that person/event opens an identity-repair case.
- The repair records the old link, new link, evidence, actor, and reason.
- A claimed roster row cannot be claimed by another person until the first link is revoked.
- A suspended person cannot create a new event membership through a fresh participant-provisioning request.
- Revoking Google identity, a GitHub installation, or a Figma authorization does not delete team-owned judging records already captured from it.

## 9. Audit

Record these access events:

- participant provisioning and resulting class;
- failed VIT-domain checks by reason, without storing raw tokens;
- roster import, claim, unlink, and rejection;
- role assignment and permission grant/batch creation, scope/constraint change, expiry, and revocation;
- reviewer/scanner device registration, station assignment, hardware-capability change, token replacement, minimum-build rejection, and revocation;
- VIT ID barcode enrollment/suspension/rebinding and external badge issue/replacement/revocation;
- authorization failure;
- emergency-pack preparation and every print-document open, with the exact snapshot/artifact checksums and authorizing grants;
- identity repair and account suspension.

Normal page views are not written to the audit log.

## 10. Acceptance checks

- A VIT Workspace account reaches VIT onboarding from either selector path.
- A personal Google account cannot complete the VIT path.
- A personal Google account can complete External onboarding.
- A participant can read/write only their own policy-approved profile; the intake/admission-model paths cannot obtain name, contact, registration number, or raw eligibility evidence through that grant.
- A participant with only membership-derived grants cannot call judging or operations functions.
- Participant provisioning and approved roster claim create revocable self support grants; an access-invitation-only account remains grantless until an explicit grant command runs.
- Self support read/reply cannot expose another reporter's case, and owning or linking a case cannot satisfy exact-case/event staff read or manage.
- Any event-linked person can receive one manually scoped permission regardless of role and can use only that permission’s exact scope.
- A pending invitation is visible only to its exact verified Google email, expires on server time, and can be revoked before claim.
- Creating an invitation for an email that is already linked returns only that outcome. Invite authority does not expose an account ID, account link, or person details without a separate matching read grant.
- A specifically invited account can receive a permission without a role label; the same Google identity has no event access before claiming the invitation, and claim itself grants nothing.
- Concurrent invitation claim, revocation, and scheduled expiry produce one version-checked winner and cannot create two event subjects.
- Suspending an account blocks its next protected read or write without deleting grants, roles, membership, or audit history.
- Reactivation fails without its independently granted exact-person permission and never restores a revoked or expired grant.
- A user cannot self-suspend and leave the event without an accountable second administrator.
- A role label without an active permission grant authorizes no protected read or command.
- Assigning, replacing, or removing a templated role changes only the exact `role_template` grants owned by the affected role row and preserves the ended role row; unrelated grant sources remain unchanged.
- A participant can mint only their own short-lived attendance QR and cannot choose its session, station direction, or membership.
- Minting a new attendance QR revokes every older active code for that membership. A successful attendance use or staffed-participant resolution consumes the presented code in the same transaction.
- Staffed resolution binds independent venue and physical-credential action slots to the exact operator, assigned phone, station, and member. A credential begin/single-step command claims its slot, and its second scan cannot move to another action, credential, operator, phone, station, or member.
- A person with `attendance.scan.execute` for one station can scan only through that station and cannot read another session’s full movement history.
- Initial VIT ID enrollment is station-scoped. Suspending and rebinding an existing VIT ID are independent exact-person permissions; each also requires the assigned current-plan phone, station-read access, visible identity confirmation, a recent Google session, and the current credential version.
- `attendance.badge.issue`, `attendance.badge.replace`, and `attendance.badge.revoke` are independent exact-person permissions. An assigned phone and station-read grant are additionally required but confer none of those participant-scoped powers.
- `attendance.venue_check_in.read`, `.record`, `.override_identity`, and `.reverse` fail independently at exact-person and event scope. A role, credential permission, station assignment, or venue-presence permission cannot substitute; exception and reversal also reject a stale Google session.
- Revoking a scanner device/station, suspending a VIT ID barcode binding, or revoking an external badge blocks the next online scan.
- A VIT ID barcode fingerprint cannot be bound to a second active event membership, and the card does not replace the Google-linked person as identity.
- A rostered reviewer can sign in on a production-like Expo build and claim only their own row.
- An unrostered Google account receives no reviewer data.
- A malformed or duplicate CSV row rejects the whole preview, and preview alone creates no import, role, or grant.
- Confirmation fails when the row state, current bundle contents, event window, or preview checksum changed; an exact operation retry returns the original import.
- Reimport leaves an already-claimed row untouched and only supersedes the exact pending row it previewed.
- Claiming one exact row creates or reuses one event subject, at most one compatible role label, and all pinned bundle grants atomically; a competing claim, revoke, replacement, or expiry cannot partially win.
- `access.roster.read`, `access.roster.import`, and `access.roster.revoke` expose and authorize different operations, and exact-row read/revoke grants do not become event-wide.
- Revoking the exact permission blocks the next protected call without waiting for session expiry.
- A future grant is ineffective before `validFrom`, becomes active through one state-checked transition, and advances the subject access version.
- Revocation racing a scheduled start always leaves the grant revoked; a delayed start or repair job cannot restore it.
- A grant is ineffective at `validUntil` even if its expiry job has not run, and the repair sweep later records `expiredAt` without extending access.
- A panel, review, team, reserve, page, or scanner grant group advances its target access version once when it adds rows and not at all on an idempotent retry.
- Applying a bundle creates individually inspectable grants; changing the bundle changes nobody until a previewed grant/revoke migration runs.
- `access.permissions.grant_scoped` and `access.permissions.revoke_scoped` cannot act outside their one permission key, resource-scope, target-person, or expiry constraints.
- Grant and revoke authority are independent: `access.permissions.grant_any` cannot revoke, and `access.permissions.revoke_any` cannot grant.
- Grant authority alone cannot execute the permission it is allowed to grant.
- Operations-health read, intelligence-brief read, and intelligence-brief generation fail independently; generating a brief grants no access to its result or any action it names.
- Application review, profile/year context, AI recommendation read/run, human decision preparation/publication, and judging context each fail independently without their exact scoped permission.
- Admission-configuration read, draft replacement, validation, and publication fail independently at event scope. None grants application read, AI-recommendation read, human decision, offer, capacity-reservation, or judging authority.
- Integration-configuration read, draft creation, validation, and publication fail independently at event scope. None grants team integration detail, provider setup, resource changes, artifact access, or shared-resource override authority.
- Reading another person’s access, assigning their role label, applying a bundle, and importing a roster each fail without their own exact permission.
- Cross-event, wrong-team, wrong-round, wrong-panel, wrong-review, wrong-station, and expired grants fail even when the permission key matches.
- A duplicated callback or retried provisioning request cannot create two memberships for one person and event.
- A member leaving a team or revoking Figma cannot erase the team’s captured checkpoints; a current lead can replace the authorizer.
- Two teams cannot claim the same provider resource in one event without an audited shared-resource exception.

## References

- [Better Auth Convex integration](https://better-auth.com/docs/integrations/convex)
- [Better Auth Expo integration](https://better-auth.com/docs/integrations/expo)
- [Better Auth OAuth state and provider handling](https://better-auth.com/docs/concepts/oauth)
- [Google OpenID Connect claims](https://developers.google.com/identity/openid-connect/openid-connect)
- [VIT Chennai IT policy naming the student Workspace domain](https://chennai.vit.ac.in/files/v2-chennai-it-policy.pdf)

# Identity and access

## 1. Authentication choice

Code2Create uses Better Auth with Google as the only sign-in provider.

Better Auth runs inside the Convex deployment through `@convex-dev/better-auth`, which is maintained by Convex. The auth component owns provider accounts, sessions, verification records, and cookies. Application tables own event membership, participant class, teams, reviewer profiles, role labels, and atomic permission grants.

There is no Clerk tenant, participant password, magic link, or role stored in an unverified client claim.

## 2. Participant sign-in

The first screen has two choices:

1. **VIT Student**
2. **External Participant**

After the choice, the user selects **Authenticate with Google**.

### Authentication intent

The server creates a short-lived `authIntent` containing:

- random nonce;
- selected participant class;
- event ID;
- return route;
- creation and expiry time.

The OAuth state carries the nonce. The server consumes an intent once after the Google callback. A client cannot change the selected class or event by editing a return URL.

### Server classification

After Google returns a verified account, the server reads:

- Google provider subject (`sub`);
- verified email;
- hosted-domain claim (`hd`), when present;
- Better Auth user and session IDs.

The server applies these rules:

| Selected path | Verified Google result | Outcome |
| --- | --- | --- |
| VIT Student | `hd` matches an approved VIT student domain | Create or resume a `vit_student` event membership |
| VIT Student | `hd` missing or not approved | Stop provisioning; explain that the VIT account is required and offer a restart as External |
| External | `hd` matches an approved VIT student domain | Classify as `vit_student`; the selector cannot bypass VIT classification |
| External | verified Google account with no approved VIT `hd` | Create or resume an `external` event membership |

Successful provisioning also creates or resumes the person’s event access subject. This is the common security boundary used by participants, rostered users, and explicitly invited accounts.

The initial approved domain is `vitstudent.ac.in`. VIT IT must confirm the final list before production opens.

Email suffix matching is not enough. Google documents `sub` as the stable user identifier and `hd` as the claim to check for Workspace-domain membership. The provider subject is stored as the external identity key; email remains a verified contact and roster-matching value.

## 3. Reviewer and staff sign-in

Reviewer and staff routes do not show the VIT/External selector.

Before the event, a caller holding `access.roster.import` for the event imports roster rows containing:

- event;
- verified Google email expected at first claim;
- person name;
- one organisational role label: `supreme`, `board`, `sc`, `jc`, or `external_judge`;
- optional versioned permission bundles and their exact scopes;
- optional External Judge domain and availability seed;
- active-from and active-until times;
- roster source and importer.

On first Google sign-in:

1. the backend looks for an unclaimed active roster row with the exact normalised verified email;
2. it checks that the row belongs to the current event;
3. it links the roster row to the Better Auth user and Google provider subject;
4. it creates or reuses the event access subject;
5. it creates the organisational role assignment;
6. it expands each permission bundle explicitly named on the roster row into person-specific grants;
7. later sign-ins use the linked user ID rather than repeating an email match.

A participant may also be rostered staff or an External Judge. The user keeps one account. Participant/team access and manually granted event permissions coexist on that person without changing the role label. An External Judge can use any verified Google account if that address is on the roster.

Roster normalisation trims whitespace and lowercases the address for lookup. It does not remove `+tags`, dots, or apply provider-specific alias rules.

An unmatched account sees a plain “not on the event roster” screen and a support code. It receives no staff data.

The first permission administrators are part of the reviewed production seed. The seed lists every access key separately and normally includes event-scoped `access.people.lookup`, `access.permissions.read`, `access.permissions.grant_any`, `access.permissions.revoke_any`, and `access.subjects.invite`. Their role label is normally Supreme, but none of this authority comes from the word `supreme`. No dashboard command can create the first grant-any or revoke-any authority. A later holder may grant either permission to another event-linked person through the ordinary audited path.

An already authenticated Google user can also be linked to the event through an explicit access invitation. Creating, suspending, and reactivating that link use separate person-scoped permissions; the invite does not assign a role or grant protected access by itself. The link command resolves one exact verified email and does not expose a global user directory. This permits a permission administrator to grant one capability to a specific user who has no staff/judging role.

## 4. Account records

| Record | Owner | Purpose |
| --- | --- | --- |
| Better Auth user/account/session | Better Auth component | Google identity link and session lifecycle |
| Person | Application | Display name, verified contact, status, and auth-user reference |
| Event access subject | Application | Active/suspended event security boundary and monotonic access version for any event-linked person |
| Event membership | Application | Participant class and event participation state |
| Event role | Application | Organisational Supreme, Board, SC, JC, or External Judge label; never an authorization decision by itself |
| Permission grant | Application | One atomic permission for one person, one event/resource scope, and one validity window |
| Permission bundle | Application | Versioned convenience template expanded into atomic grants |
| Permission grant batch | Application | One audited manual, roster, membership, assignment, or bundle operation that created/revoked grants |
| Roster entry | Application | Approved reviewer/staff invitation and first-sign-in claim |
| Device | Application | Reviewer/scanner installation, app version, hardware capabilities, station assignment, notification token, and revocation state |
| Attendance credential | Application | Event-scoped VIT ID card fingerprint binding, external badge QR, and short-lived portal QR state; raw card identifiers/bearers are not stored |
| Provider authorization | Application security boundary | One encrypted Figma App/user grant or GitHub App installation reference used only by server jobs |
| Team integration | Team | Selected provider resources, repository classifications, checkpoint sets, statistics, and review visibility |

The application does not copy session secrets or raw Google access tokens into its domain tables. Provider authorizations grant API access, but they do not own the connected repository set, Figma file, or captured evidence.

## 5. Roles, permission grants, and bundles

The event keeps five organisational labels:

| Role | Suggested default permission template |
| --- | --- |
| Supreme | Permission administration and broad event-governance defaults |
| Board | Policy, admissions, rubric, results, correction, export, and override defaults |
| SC | Workflow-management defaults for selected operational scopes |
| JC | Frontline execution defaults for selected station, table, queue, support, verification, or playback scopes |
| External Judge | Assigned-panel context, presence, and own-scorecard defaults |

Roles exist for roster grouping, display, sensible starting bundles, and training. A protected Convex function never authorizes from the role string. There is no hard role ceiling.

Any authenticated person linked to the event may receive any permission regardless of role, including a participant or External Judge. The grant must name:

- one stable permission key from the server-owned permission catalog;
- the exact subject person and event;
- an exact scope type and scope ID, or an intentional event-wide scope;
- `validFrom` and `validUntil`;
- optional catalog-defined constraints such as device, station, own-record-only, or fresh-authentication requirement;
- source, grantor, reason, and grant batch.

Permission keys are atomic. Examples include:

- `access.permissions.read`
- `access.permissions.grant_any`
- `access.permissions.revoke_any`
- `access.permissions.grant_scoped`
- `access.permissions.revoke_scoped`
- `access.roles.assign`
- `access.roster.import`
- `access.subjects.invite`
- `access.subjects.suspend`
- `access.permission_bundles.apply`
- `attendance.scan.execute`
- `attendance.presence.reconcile`
- `review.scorecard.submit`
- `review.presence.waive`
- `round.close`
- `records.export.identifiable`

There is no `admin`, `all`, or `*` permission checked by application functions. Event-wide scope is explicit and visible; it is not inferred from Supreme or Board.

### Arbitrary per-user grants

A person with event-scoped `access.permissions.grant_any` can grant any catalog permission to any event-linked person at any time, regardless of either person’s role. Event-scoped `access.permissions.revoke_any` independently allows revocation. Holding one never implies the other. The permission-management screen requires the actor to choose the permission, scope, start/end time, constraints, and reason and previews the target’s effective access before committing.

Each `access.permissions.grant_scoped` grant delegates one named permission key inside one maximum resource scope, target-person boundary, and expiry ceiling. `access.permissions.revoke_scoped` is a separate grant with the same shape. Several rows are required to delegate several permissions. A scoped delegator cannot cross into another event, omit a required scope, act on an excluded target, exceed the ceiling, or manufacture broader delegation for themselves.

Grant authority is not execution authority. A person who can grant `round.close` but does not hold `round.close` cannot close a round; they must create a separate, visible grant first. Scoped grant authority cannot issue `access.permissions.grant_any`, `access.permissions.revoke_any`, `access.permissions.grant_scoped`, or `access.permissions.revoke_scoped`; only `grant_any` can issue grant-authority keys.

Access administration is decomposed like every other area. Looking up event people, reading another person’s grants, assigning a role label, importing a roster, publishing a permission bundle, applying a bundle, migrating existing bundle-sourced grants, granting, and revoking use separate keys. A person may hold any subset. For example, `access.permission_bundles.apply` can be scoped to one bundle and constrained to named targets without permitting bundle editing, role changes, or direct manual grants.

Applying a suggested role-default template or operational bundle is only a separate shortcut. It creates `permissionGrants` rows tied to one `permissionGrantBatch`. Assigning or changing a role label never applies, removes, or migrates a bundle. Editing a bundle later also changes nobody until a previewed migration or new grant/revoke batch runs.

Team membership, team lead, panel assignment, scanner-station assignment, incident command, and release ownership use the same model: each assignment materialises narrowly scoped permissions and revokes only the grants sourced from that assignment when it ends.

No shared Supreme or Board account is permitted. A role, grant, or seniority never permits editing another person’s submitted scorecard, bypassing a conflict/state/device check, or changing captured evidence unless a separate, explicit override permission exists for that exact action and scope.

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

Each permission definition states whether an ancestor grant may cover a child resource. The backend proves containment by loading indexed records—for example, that a panel belongs to the granted round—never by trusting an ID prefix or client claim. Sensitive keys may forbid event-wide or ancestor scope and require the exact leaf record. A grant for one resource type is never coerced into another.

## 6. Data visibility

### Participant and team grants

Participant provisioning materialises self-scoped permissions for the participant’s profile, attendance status, dynamic QR, correction route, and event configuration. Joining a team materialises team-scoped permissions for its members, intake, brief, tracks, project material, integrations, table, readiness, queue, review progress, and released feedback. Team-lead assignment adds only the lead’s team-management permissions.

Those grants never include another team’s private submission, unreleased judge identity, score, panel note, conflict, staff location, or another participant’s detailed presence history. Leaving or being removed from a team revokes the grants sourced from that team membership without touching unrelated manual grants.

### Application-review grants

An application assignment materialises `application.review.read` and `application.recommendation.submit_own` for that application and person. It exposes only the confirmed project brief, approved source answers, fresh-project attestation, confirmed tracks, permitted team fields, and the caller’s own recommendation. It does not expose hidden model suggestions, peer recommendations before submission, or the venue judging rubric. The assignee’s role is irrelevant.

### Judging grants

A panel/review assignment materialises only the permissions needed for that judge and review: clock-in/page response where applicable, assigned project context, the frozen evidence checkpoint, released previous findings/commitments, presence, and the caller’s own scorecard. The permissions are scoped to the round, panel, review session, and person.

The ordinary assignment bundle does not include peer score values, unrelated teams, hidden participant data, staff audit history, or another judge’s scorecard. Although External Judge is the normal role label, the same exact grants can be issued manually to another role when required.

### Operations grants

Operations screens are assembled from granular read permissions. A station grant may expose only the identity/current state needed to scan at that station; another grant may expose panel completeness without score values; another may expose one integration’s health. Exact movement history, sensitive exceptions, emergency roll call, score values, and identifiable exports each require separate permissions and scopes. No permission exposes raw provider tokens, VIT card identifiers/fingerprints, session cookies, or QR bearers.

## 7. Sessions and devices

- Better Auth sessions expire after seven days and may refresh after twelve hours of activity.
- Permission grants have explicit validity windows and cannot outlive the configured event/access ceiling.
- Revoking a permission affects the next protected backend call even if the Google session and role label remain valid.
- Changing a role label changes no grant. Removing prior template-sourced access or applying the new role’s suggested bundle requires separate, explicitly authorised operations.
- Web sessions use secure, HTTP-only, same-site cookies.
- The Expo Better Auth client stores session cookies in `expo-secure-store`.
- The Expo app registers one device record with platform, build number, camera/NFC capability, notification token, last-seen time, and revocation state.
- Reviewer clock-in and attendance scanning reject a revoked device or an app below the configured minimum build.
- A scanner must also have an active station assignment whose event, mode, zone, direction, and validity match the command.
- Grant/revoke operations, overrides, attendance-history reconciliation, post-lock score corrections, role-template migrations, and raw exports require a session created within the previous 30 minutes. An older session is sent through Google sign-in again.

The exact session settings live in security configuration and must be tested on real web and mobile builds.

## 8. Identity changes and duplicates

- Accounts are never merged only because two Google identities share an email.
- If a provider subject changes or a rostered email was wrong, a caller with `identity.repair.open` for that person/event opens an identity-repair case.
- The repair records the old link, new link, evidence, actor, and reason.
- A claimed roster row cannot be claimed by another person until the first link is revoked.
- A suspended person cannot create a new event membership through a fresh auth intent.
- Revoking Google identity, a GitHub installation, or a Figma authorization does not delete team-owned judging records already captured from it.

## 9. Audit

Record these access events:

- participant provisioning and resulting class;
- failed VIT-domain checks by reason, without storing raw tokens;
- roster import, claim, unlink, and rejection;
- role assignment and permission grant/batch creation, scope/constraint change, expiry, and revocation;
- reviewer/scanner device registration, station assignment, hardware-capability change, token replacement, minimum-build rejection, and revocation;
- VIT ID card enrolment/suspension/rebinding and external badge issue/replacement/revocation;
- privileged reauthentication failure;
- identity repair and account suspension.

Normal page views are not written to the audit log.

## 10. Acceptance checks

- A VIT Workspace account reaches VIT onboarding from either selector path.
- A personal Google account cannot complete the VIT path.
- A personal Google account can complete External onboarding.
- A participant with only membership-derived grants cannot call judging or operations functions.
- Any event-linked person can receive one manually scoped permission regardless of role and can use only that permission’s exact scope.
- A specifically invited account can receive a permission without a role label; the same Google identity has no event access before claiming the invitation.
- A role label without an active permission grant authorizes no protected read or command.
- A participant can mint only their own short-lived attendance QR and cannot choose its session, station direction, or membership.
- A person with `attendance.scan.execute` for one station can scan only through that station and cannot read another session’s full movement history.
- Revoking a scanner device/station, suspending a VIT card binding, or revoking an external badge blocks the next online scan.
- A VIT card fingerprint cannot be bound to a second active event membership, and the card does not replace the Google-linked person as identity.
- A rostered reviewer can sign in on a production-like Expo build and claim only their own row.
- An unrostered Google account receives no reviewer data.
- Revoking the exact permission blocks the next protected call without waiting for session expiry.
- Applying a bundle creates individually inspectable grants; changing the bundle changes nobody until a previewed grant/revoke migration runs.
- `access.permissions.grant_scoped` and `access.permissions.revoke_scoped` cannot act outside their one permission key, resource-scope, target-person, or expiry constraints.
- Grant and revoke authority are independent: `access.permissions.grant_any` cannot revoke, and `access.permissions.revoke_any` cannot grant.
- Grant authority alone cannot execute the permission it is allowed to grant.
- Reading another person’s access, assigning their role label, applying a bundle, and importing a roster each fail without their own exact permission.
- Cross-event, wrong-team, wrong-round, wrong-panel, wrong-review, wrong-station, and expired grants fail even when the permission key matches.
- A duplicated callback cannot consume an auth intent twice or create two memberships.
- A member leaving a team or revoking Figma cannot erase the team’s captured checkpoints; a current lead can replace the authorizer.
- Two teams cannot claim the same provider resource in one event without an audited shared-resource exception.

## References

- [Better Auth Convex integration](https://better-auth.com/docs/integrations/convex)
- [Better Auth Expo integration](https://better-auth.com/docs/integrations/expo)
- [Better Auth OAuth state and provider handling](https://better-auth.com/docs/concepts/oauth)
- [Google OpenID Connect claims](https://developers.google.com/identity/openid-connect/openid-connect)
- [VIT Chennai IT policy naming the student Workspace domain](https://chennai.vit.ac.in/files/v2-chennai-it-policy.pdf)

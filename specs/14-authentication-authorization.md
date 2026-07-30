# Authentication and authorization

## 1. Product decision

Code2Create uses Google authentication.

The participant entry asks:

1. **VIT student**
2. **External participant**

Only after that choice does the user select **Authenticate with Google**.

Clerk brokers Google authentication and manages web/mobile application sessions. Convex verifies the Clerk identity and makes every application authorization decision against current Code2Create records.

## 2. Concepts that must remain separate

| Concept | Examples | Authority |
| --- | --- | --- |
| Upstream identity | Google `sub`, verified email, `hd` | Google |
| Application session | Clerk subject/session | Clerk |
| Event account class | `vit_student`, `external`, `staff_only` | Code2Create provisioning policy |
| Event membership | onboarding, active, ineligible, suspended | Code2Create |
| Role template | participant, reviewer, ops, review admin, board | Code2Create roster/grant administration |
| Capability | `review.score_assigned`, `board.override` | Code2Create backend |
| Scope | event, round, panel, team, criterion, zone | Code2Create backend |

A VIT student is not automatically a reviewer. An external participant is not automatically an external judge. A board title does not automatically permit editing another reviewer’s score.

## 3. Participant authentication flow

### 3.1 Account-class selector

The first screen contains two large choices and a short explanation:

- **VIT student** — use the VIT Google Workspace account.
- **External participant** — use a verified Google account and provide institution details.

On selection, the backend creates `authIntents`:

- random 256-bit nonce; only its hash is stored;
- requested account class;
- safe same-origin return path;
- browser/session binding hash;
- creation and short expiry;
- single-use status.

The raw nonce is placed in protected state for the OAuth continuation. Account class is not accepted from a free client field after callback.

### 3.2 Google authentication

Clerk is configured with:

- Google as the only public social connection;
- production-owned Google OAuth credentials;
- exact web, Android, and iOS redirects;
- required `openid email profile` scopes;
- account linking and session policy reviewed for the event;
- no email/password, SMS, or unrelated social sign-up path.

The Google account chooser may receive `hd=vitstudent.ac.in` as a hint on the VIT path. Google explicitly treats this as a UI optimization, not access control. The server must still validate the returned claim.

### 3.3 Server-side provisioning

After Clerk creates/authenticates the session:

1. require current Clerk user;
2. load and validate the unconsumed auth intent;
3. retrieve the Google OAuth connection’s OIDC ID token server-side using Clerk’s backend API;
4. verify the token with Google’s public keys/library;
5. validate issuer, audience, expiry, signature, and subject;
6. require `email_verified = true`;
7. for VIT path, require `hd` exactly in the active `vitStudentHostedDomains` allowlist;
8. resolve or create the internal user by Google provider subject/Clerk subject;
9. create the event membership with the requested class;
10. consume the auth intent and write identity/provisioning audit events in the same application transaction;
11. discard the Google ID/access token without storing it in Convex.

If the Google connection does not yield a verifiable ID token in the chosen Clerk flow, VIT provisioning fails closed. An engineering spike must prove this path against staging credentials before registration UI is considered complete.

### 3.4 Stable identity

Google’s `sub` claim is the upstream stable identifier. The application never uses email as the primary identity because email can change and Google warns it is not a stable account identifier.

Store:

- internal `userId`;
- Clerk subject;
- Google provider subject;
- current verified contact email;
- hosted domain and verification method/time;
- no reusable Google credential.

## 4. VIT Student policy

The initial student Workspace domain is:

```text
vitstudent.ac.in
```

The domain comes from VIT’s published IT policy, but production still requires confirmation with the event/VIT technical owner.

VIT classification passes only when:

- Google token is valid for a configured Code2Create OAuth client;
- email is verified;
- `hd` exists;
- normalized `hd` equals an active configured VIT student domain;
- identity is not blocked, merged, or already provisioned incompatibly;
- auth intent requested `vit_student`.

It fails when:

- a personal Gmail account has an email alias resembling VIT;
- email text ends with the expected suffix but `hd` is absent;
- hosted domain differs;
- token audience/issuer/expiry/signature fails;
- intent expired, was consumed, or is not bound to the callback context.

Failure screen:

> This Google account was authenticated, but it is not verified as a VIT student Workspace account. Use your VIT student Google account or start again as an External participant.

Do not expose raw token/claim diagnostics to the user. Preserve a safe correlation code for support.

## 5. External participant policy

External provisioning requires:

- valid Google identity;
- verified email;
- selected `external` auth intent;
- event registration open;
- accepted terms.

After provisioning collect:

- institution or organization;
- programme/course/role;
- city and country;
- expected graduation year where relevant;
- event eligibility evidence only if policy requires it.

External status never lowers rubric weights or changes score calculations. Eligibility policy may differ, but judging uses the published rubric.

If a VIT Google account selected External, the system respects the explicit selection. Reclassification to VIT Student is a named command that re-verifies hosted-domain evidence and records an audit event.

## 6. Managed VIT Workspace hardening

Preferred production hardening—if VIT IT participates—is a managed Google Workspace enterprise connection in Clerk for `vitstudent.ac.in`.

Benefits:

- domain-specific IdP routing;
- centrally configured VIT Workspace application;
- stronger lifecycle/deprovisioning options;
- less reliance on a social-connection token extraction detail.

This requires VIT IT coordination, Google Admin configuration, testing, and potentially a paid Clerk plan. It is not silently assumed. The application user ID, event membership, capability model, and Convex auth contract remain the same if this path replaces social Google OIDC.

## 7. Returning participant

1. User selects sign in/authenticate.
2. Clerk authenticates with Google.
3. Convex resolves current user by Clerk subject.
4. `viewer.me` returns active event memberships and next route.
5. If provider identity or hosted-domain verification needs refresh under policy, the user is routed through re-verification before sensitive eligibility actions.

Returning login does not ask account class again when a valid membership exists.

## 8. Reviewer and staff invitation

Reviewer/staff/admin access starts in `rosterInvitations`, never in public sign-up.

### Roster preparation

Each entry includes:

- event;
- normalized expected Google email;
- Google subject if already known;
- role template;
- exact scopes;
- training/activation requirements;
- issuer and expiry;
- status.

### Claim

1. Invitee opens a single-use invitation or signs in through the staff route.
2. Google/Clerk authentication succeeds.
3. Backend first matches known provider subject, otherwise verified normalized email for initial claim.
4. Ambiguous/multiple matches are blocked.
5. User accepts event terms and completes required profile/training.
6. Claim mutation consumes invitation and creates inactive/active grants as policy dictates.
7. Reviewer app registers device and notifications.

An authenticated but unrostered user sees “No staff access has been assigned” and can still use valid participant membership.

### Activation

A reviewer grant becomes active only when:

- roster claim complete;
- reviewer profile complete;
- required training passed;
- criterion grants approved;
- conflict declaration complete;
- supported device/app requirements met where configured.

## 9. Clerk-to-Convex identity

Convex `auth.config.ts` trusts only the production/staging Clerk issuer configured for that environment.

Backend functions use the token subject to find `users.clerkSubject`. Session claims contain minimal identity and do not embed long-lived application authorization as the sole truth.

For ordinary low-risk queries, a short-lived capability summary may reduce reads if it is versioned and checked. For all outcome-affecting mutations:

- read active user status;
- read active role grants;
- evaluate current scope;
- enforce current entity state/configuration;
- reject revoked or expired authority immediately.

## 10. Authorization model

### Capability examples

```text
profile.manage_own
team.create
team.manage_own
team.invite
project.edit_own
project.submit_own
queue.declare_ready
queue.withdraw_own
reviewer.clock_in
reviewer.respond_page
review.scan_presence
review.observe
review.score_assigned
review.submit_own
panel.start_review
panel.complete_review
ops.manage_tables
ops.manage_queue
ops.page_reviewer
review_admin.configure_round
review_admin.manage_panels
review_admin.inspect_submitted_scores
board.override
board.close_round
board.publish_decision
synesthesia.vote
synesthesia.moderate
audit.read
export.sensitive
```

### Scope

Grants may cover:

- entire event;
- one/more rounds;
- one panel;
- assigned teams;
- granted criteria;
- venue zone;
- moderation function.

The backend guard receives capability plus resource context and returns an evaluated authorization object used by audit.

### No role-name checks

Avoid:

```ts
if (user.role === "admin") { ... }
```

Require:

```ts
const authz = await requireCapability(ctx, "ops.manage_queue", {
  eventId,
  roundId,
  panelId,
});
```

## 11. Sensitive-action step-up

Require recent Clerk re-verification and current capability for:

- board override;
- round reopen/close after publication;
- score correction after lock;
- user merge;
- role grant or revocation;
- identity reclassification;
- sensitive export;
- degraded-mode activation;
- retention/redaction execution.

Store only a verified-at timestamp/session assurance reference needed to enforce the window. Exact MFA/re-verification policy remains a security decision.

## 12. Session and logout

- Clerk manages browser/native session token rotation and revocation.
- Web and mobile logout revoke local session state and call application device cleanup.
- Reviewer logout checks the encrypted outbox. Acknowledged items are purged; unresolved items require explicit discard/support handling.
- Device revocation disables push tokens and blocks future device-bound commands.
- Suspension/grant revocation is enforced server-side on the next protected query/mutation.
- High-risk screens periodically re-evaluate current grants and recent authentication.

## 13. Account linking and duplicate recovery

Automatic merge is allowed only when Clerk/Google proves the same account under configured linking rules.

Manual merge:

1. privileged administrator opens duplicate case;
2. compares verified provider subjects, memberships, teams, submissions, and grants;
3. chooses surviving user;
4. transaction redirects mutable references where safe;
5. source user becomes `merged`;
6. immutable history retains original actor plus canonical mapping;
7. role conflicts and team uniqueness are resolved explicitly;
8. audit records the full action and reason.

Never merge solely because names or unverified emails look similar.

## 14. Error codes

| Code | User-facing direction |
| --- | --- |
| `AUTH_INTENT_EXPIRED` | Start again at VIT Student/External |
| `AUTH_INTENT_REPLAYED` | Continue with existing account or contact support |
| `GOOGLE_IDENTITY_UNAVAILABLE` | Retry Google authentication |
| `GOOGLE_TOKEN_INVALID` | Retry; support uses correlation ID |
| `VIT_HOSTED_DOMAIN_REQUIRED` | Use VIT Workspace account or choose External |
| `IDENTITY_ALREADY_LINKED` | Sign in to existing account/contact support |
| `REGISTRATION_CLOSED` | Read-only event information |
| `ROSTER_INVITE_NOT_FOUND` | Authenticated, no staff access |
| `ROSTER_INVITE_AMBIGUOUS` | Contact review operations |
| `GRANT_INACTIVE` | Complete training or contact operations |
| `CAPABILITY_REQUIRED` | Action unavailable for current role/scope |
| `RECENT_AUTH_REQUIRED` | Re-authenticate, then retry |
| `ACCOUNT_SUSPENDED` | Access blocked; contact event support |

Errors returned to clients contain no provider token, raw claims, roster secrets, or private security reason.

## 15. Threat controls

| Threat | Control |
| --- | --- |
| User changes selector query parameter after Google | Server consumes signed/bound auth intent |
| Personal account spoofs VIT-looking email | Validate Google `hd`, not suffix |
| Email changes | Link by provider subject |
| Uninvited user discovers staff route | Roster claim required |
| Client edits role metadata | Backend reads current grants |
| Revoked reviewer keeps open app | Sensitive writes re-read grant/user status |
| OAuth callback redirect attack | Exact redirect allowlist and same-origin safe return path |
| Replay of invitation/auth intent | Hashed single-use token plus expiry |
| Stolen QR | Short expiry, action/round/assignment scope, authenticated reviewer |
| Shared reviewer account | Policy prohibition, per-user roster, device/audit anomaly detection |
| Token leakage in logs | Structured redaction and no token persistence |
| Lost reviewer phone | Clerk session revoke + device revoke + push disable |

## 16. Acceptance tests

1. Valid `vitstudent.ac.in` Workspace account on VIT path provisions VIT membership.
2. Personal Gmail on VIT path authenticates but fails VIT provisioning.
3. Fabricated VIT-looking email with no valid `hd` fails.
4. External Google account provisions External membership.
5. Replayed auth intent cannot create/change membership.
6. Existing user returns to the same internal ID after email display change.
7. VIT user selecting External remains external until audited reclassification.
8. Unrostered authenticated user cannot open reviewer/operations data.
9. Rostered reviewer receives only assigned event/round/criterion capability.
10. Revoked grant blocks the next mutation while the app is still open.
11. Board override fails without recent re-verification.
12. Staff route never grants authority from email domain alone.
13. Logout/revocation disables device push and prevents new device-bound commands.
14. Staging token/issuer is rejected by production Convex and vice versa.

## 17. References

- [Google OIDC claim reference](https://developers.google.com/identity/openid-connect/reference)
- [Clerk Google sign-in for Expo](https://clerk.com/docs/expo/guides/configure/auth-strategies/sign-in-with-google)
- [Clerk OAuth token retrieval](https://clerk.com/docs/reference/backend/user/get-user-oauth-access-token)
- [Clerk Google Workspace SAML connection](https://clerk.com/docs/guides/configure/auth-strategies/enterprise-connections/saml/google)
- [Convex and Clerk integration](https://docs.convex.dev/auth/clerk)
- [VIT Chennai IT policy describing `vitstudent.ac.in`](https://chennai.vit.ac.in/files/v2-chennai-it-policy.pdf)

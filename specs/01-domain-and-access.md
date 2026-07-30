# Identity and access

## 1. Authentication choice

Code2Create uses Better Auth with Google as the only sign-in provider.

Better Auth runs inside the Convex deployment through `@convex-dev/better-auth`, which is maintained by Convex. The auth component owns provider accounts, sessions, verification records, and cookies. Application tables own event membership, participant class, teams, reviewer profiles, and role grants.

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

The initial approved domain is `vitstudent.ac.in`. VIT IT must confirm the final list before production opens.

Email suffix matching is not enough. Google documents `sub` as the stable user identifier and `hd` as the claim to check for Workspace-domain membership. The provider subject is stored as the external identity key; email remains a verified contact and roster-matching value.

## 3. Reviewer and staff sign-in

Reviewer and staff routes do not show the VIT/External selector.

Before the event, an administrator imports roster rows containing:

- event;
- verified Google email expected at first claim;
- person name;
- role;
- optional panel, track, or team scope;
- active-from and active-until times;
- roster source and importer.

On first Google sign-in:

1. the backend looks for an unclaimed active roster row with the exact normalised verified email;
2. it checks that the row belongs to the current event;
3. it links the roster row to the Better Auth user and Google provider subject;
4. it creates the named role grant;
5. later sign-ins use the linked user ID rather than repeating an email match.

A participant may also be a rostered volunteer or reviewer. The user keeps one account and receives separate event grants. An external judge can use any verified Google account if that address is on the roster.

Roster normalisation trims whitespace and lowercases the address for lookup. It does not remove `+tags`, dots, or apply provider-specific alias rules.

An unmatched account sees a plain “not on the event roster” screen and a support code. It receives no staff data.

## 4. Account records

| Record | Owner | Purpose |
| --- | --- | --- |
| Better Auth user/account/session | Better Auth component | Google identity link and session lifecycle |
| Person | Application | Display name, verified contact, status, and auth-user reference |
| Event membership | Application | Participant class and event participation state |
| Role grant | Application | Time-bound role with event and optional resource scope |
| Roster entry | Application | Approved reviewer/staff invitation and first-sign-in claim |
| Device | Application | Reviewer installation, app version, notification token, and revocation state |
| Provider authorization | Application security boundary | One encrypted Figma App/user grant or GitHub App installation reference used only by server jobs |
| Team integration | Team | Selected provider resources, repository classifications, checkpoint sets, statistics, and review visibility |

The application does not copy session secrets or raw Google access tokens into its domain tables. Provider authorizations grant API access, but they do not own the connected repository set, Figma file, or captured evidence.

## 5. Roles and permissions

Permissions are granted by capability. A role is a named bundle of capabilities.

| Role | Main access |
| --- | --- |
| Participant | Own profile, own teams, project versions, readiness, own queue state, own review progress, Synesthesia |
| Application reviewer | Assigned pre-event applications, their own admission reviews, and no venue judging score |
| Admissions administrator | Eligibility checks, application assignment, shortlist/waitlist decisions, offers, and confirmation capacity |
| Reviewer | Own clock-in, pages, assigned reviews, project context, presence, own scorecards |
| Panel lead | Reviewer access plus panel completion and non-score operational checks |
| Review operations | Panels, tables, queues, pages, substitutions, review exceptions, completeness |
| Review administrator | Rubrics, criterion assignments, correction requests, score reveal, round close |
| Event administrator | Event configuration, rosters, grants, exports, and support actions |
| Board | Named emergency overrides and final-round decisions |
| Auditor | Read-only event history and approved exports |
| Synesthesia moderator | Request moderation and playback queue control |
| Playback operator | Current Synesthesia item and playback acknowledgement |

Team lead is a team-membership permission, not a global event role.

### Capability checks

Each public Convex function checks:

1. a valid Better Auth identity;
2. an active person record;
3. active event membership where required;
4. the named capability;
5. event and resource scope;
6. the current object state;
7. conflict-of-interest restrictions;
8. session or device requirements for the command.

The web route guard improves navigation. It does not replace checks inside Convex.

## 6. Data visibility

### Participants can see

- their own personal record;
- members and project material for their teams;
- their team’s GitHub/Figma resource, connection state, freshness, statistics, and checkpoints;
- their team’s table, ready state, queue state, review status, and released feedback;
- public event configuration and Synesthesia state.

They cannot see other teams’ private submissions, reviewer identities before policy allows it, scores, panel notes, conflicts, or staff locations.

### Application reviewers can see

Application reviewers see only applications assigned to them, the project/team fields approved for admission review, and their own recommendation. They do not see another reviewer’s recommendation before submitting and cannot use the venue judging rubric.

### Reviewers can see

- their profile, device state, clock-in state, pages, and assignments;
- project context for a currently assigned or recently completed review;
- the frozen GitHub repository-set/Figma manifest and captured evidence fixed to those reviews;
- previous-round findings and commitments released to that review;
- their own draft and submitted scorecards.

They cannot see peer score values before the configured reveal point, unrelated teams, hidden participant data, or staff-only audit records.

### Operations can see

Operations views show what is needed to move the event: status, table, panel, timer, missing presence, missing scorecards, integration health, and exception reason. Score values require a separate review-administrator or board capability. Raw provider credentials are never an operations capability.

## 7. Sessions and devices

- Better Auth sessions expire after seven days and may refresh after twelve hours of activity.
- Event role grants expire independently, normally six hours after the event closes.
- Removing a role takes effect on the next protected backend call even if the Google session remains valid.
- Web sessions use secure, HTTP-only, same-site cookies.
- The Expo Better Auth client stores session cookies in `expo-secure-store`.
- The reviewer app registers one device record with platform, build number, notification token, last-seen time, and revocation state.
- Clock-in rejects a revoked device or an app below the configured minimum build.
- Board overrides, post-lock score corrections, role changes, and raw exports require a session created within the previous 30 minutes. An older session is sent through Google sign-in again.

The exact session settings live in security configuration and must be tested on real web and mobile builds.

## 8. Identity changes and duplicates

- Accounts are never merged only because two Google identities share an email.
- If a provider subject changes or a rostered email was wrong, an event administrator opens an identity-repair case.
- The repair records the old link, new link, evidence, actor, and reason.
- A claimed roster row cannot be claimed by another person until the first link is revoked.
- A suspended person cannot create a new event membership through a fresh auth intent.
- Revoking Google identity, a GitHub installation, or a Figma authorization does not delete team-owned judging records already captured from it.

## 9. Audit

Record these access events:

- participant provisioning and resulting class;
- failed VIT-domain checks by reason, without storing raw tokens;
- roster import, claim, unlink, and rejection;
- role grant, scope change, expiry, and revocation;
- reviewer device registration, token replacement, minimum-build rejection, and revocation;
- privileged reauthentication failure;
- identity repair and account suspension.

Normal page views are not written to the audit log.

## 10. Acceptance checks

- A VIT Workspace account reaches VIT onboarding from either selector path.
- A personal Google account cannot complete the VIT path.
- A personal Google account can complete External onboarding.
- A participant cannot call reviewer or operations functions.
- A rostered reviewer can sign in on a production-like Expo build and claim only their own row.
- An unrostered Google account receives no reviewer data.
- Revoking a role blocks the next protected call without waiting for session expiry.
- A duplicated callback cannot consume an auth intent twice or create two memberships.
- A member leaving a team or revoking Figma cannot erase the team’s captured checkpoints; a current lead can replace the authorizer.
- Two teams cannot claim the same provider resource in one event without an audited shared-resource exception.

## References

- [Better Auth Convex integration](https://better-auth.com/docs/integrations/convex)
- [Better Auth Expo integration](https://better-auth.com/docs/integrations/expo)
- [Better Auth OAuth state and provider handling](https://better-auth.com/docs/concepts/oauth)
- [Google OpenID Connect claims](https://developers.google.com/identity/openid-connect/openid-connect)
- [VIT Chennai IT policy naming the student Workspace domain](https://chennai.vit.ac.in/files/v2-chennai-it-policy.pdf)

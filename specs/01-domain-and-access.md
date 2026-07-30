# Domain and access model

## 1. Canonical entities

Every entity has an immutable system identifier, created/updated timestamps, version, status, and audit metadata where applicable.

| Entity | Required meaning |
| --- | --- |
| User | One application identity anchored to a Clerk subject and verified Google identity |
| AuthIntent | Short-lived signed record of VIT-student/external selection, nonce, and safe return path |
| IdentityLink | Stable provider link containing Clerk subject, Google `sub`, provider, and verification metadata |
| AccountClass | Participant classification: `vit_student` or `external`; never an authorization role |
| RoleGrant | A time-bounded, event-scoped capability bundle granted to a user from an approved roster |
| Device | Registered reviewer/staff installation, app version, platform, and last-seen health |
| PushToken | Revocable Expo/native push token tied to a user and device |
| ReviewerProfile | Expertise, interests, declared conflicts, eligibility, and availability |
| Team | Participant group and public team identity |
| TeamMembership | Person-to-team relationship, role, invitation state |
| ProjectProfile | Versioned project answers, track, evidence links, tools, and disclosures |
| VenueTable | Physical table identifier, zone, and availability |
| TableAssignment | Time-bounded team-to-table association |
| Round | Review phase, schedule, state, timing policy, and elimination policy |
| EventConfig | Frozen event policy revision referenced by rounds, rubrics, and clients |
| Criterion | Rubric item, definition, weight, scale, evidence guidance |
| ReviewerCriterionGrant | Criteria a reviewer may score, with qualification source |
| Panel | A group of reviewers operating together during a round |
| PanelMembership | Reviewer-to-panel assignment and attendance state |
| TeamPanelAssignment | Team routed to a panel for a round, plus reason and status |
| QueueEntry | Ordered, participant-visible review position |
| ReviewSession | One panel reviewing one team in one round |
| ReviewPresence | Proof that each required reviewer was physically present |
| Score | Independent reviewer score for one criterion |
| EvidenceRecord | Observed capability, demo, link, claim, milestone, or risk |
| ReviewNote | Structured or free-text note with visibility rules |
| Extension | Approved addition to review time |
| Page | Alert sent to a reviewer or substitute |
| Override | Exceptional privileged action with reason and audit trail |
| CommandReceipt | Durable idempotent acknowledgement for a client command and resulting versions |
| DomainEvent | Append-only business event emitted in the same transaction as authoritative state |
| NotificationJob | Retryable external-delivery request derived from a domain event |
| Decision | Elimination, finalist, award, or disqualification record |
| SongRequest | Synesthesia track request |
| SongVote | One person's active vote on a request |
| PlaybackItem | Moderated item in playback history or queue |
| AuditEvent | Append-only record of a security or operational action |

## 2. Identity and account-class rules

- Authentication is Google-only for participants, reviewers, and staff.
- Clerk owns login sessions and exposes a stable subject to web, mobile, and Convex.
- The application stores Google `sub` as the stable upstream identity link. Email is a verified contact/display attribute and is not a database primary key.
- One human should have one event user. Automatic account linking is allowed only when the identity provider proves control; uncertain duplicates enter an administrator merge workflow.
- The public participant flow asks **VIT student** or **External participant** before opening Google authentication.
- The choice creates a short-lived `AuthIntent` containing a random nonce, requested account class, safe return path, creation time, and expiry. The callback consumes it once.
- `vit_student` requires a verified Google identity whose `hd` claim exactly matches an active domain in `identityPolicies.vitStudentHostedDomains`. The initial value is `vitstudent.ac.in`.
- The server validates the Google token signature, issuer, audience, expiry, nonce where available, `sub`, `email_verified`, and `hd`. It never grants VIT status from `email.endsWith(...)`.
- `external` requires a verified Google identity and then collects institution, city/country, and participant affiliation. It does not imply lower judging eligibility.
- A VIT-domain user who deliberately selected External remains external for that event unless an authorised reclassification command records the reason.
- A non-VIT user who selected VIT Student fails closed and can restart as External. The system never silently downgrades the selection.
- Account class can affect registration policy and forms. It cannot grant reviewer, operations, moderator, auditor, or administrator capability.
- Staff and reviewer capability comes from a roster/invitation matched to the verified identity, followed by required training and activation.
- A removed or suspended user immediately loses new-write authority. Already submitted records remain attributed and immutable.

## 3. Authentication routes

| Entry route | Required flow | Result |
| --- | --- | --- |
| Participant registration | Select account class → Google → provision identity → complete profile | Participant-capable user with `vit_student` or `external` classification |
| Returning participant | Google → resolve existing identity | Existing participant context and team |
| Reviewer invitation | Open invite → Google → roster match → accept terms/training | Reviewer grant scoped to event/round/criteria |
| Staff/admin invitation | Open invite → Google → roster match → optional step-up | Narrow staff capability grant |
| Uninvited Google account on staff route | Google succeeds; roster match fails | Authenticated but no staff authority |

Authentication success and application authorization success are separate outcomes.

## 4. Role permissions

Legend: **R** read, **W** create/update within scope, **A** exceptional authority, **—** no access.

| Capability | Participant | Reviewer | Panel lead | Ops | Review admin | Board admin | Auditor |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Own team/project | W | R when assigned | R when assigned | R | R | R | R |
| Other teams | Public status only | Assigned team only | Assigned team only | Operational fields | R | R | R |
| Own score draft | — | W | W | — | R after submit | R | R |
| Another reviewer's score | — | Hidden until permitted | Hidden until permitted | — | R after lock | R | R |
| Panel attendance | Own visible status | Own W | Panel R | W | W | A | R |
| Queue | Own/team view | Assigned view | Panel view | W | W | A | R |
| Panel definitions | — | Own R | Own R | R | W | A | R |
| Assignment recommendation | — | — | R | W | W | A | R |
| Begin/complete review | Team status only | W if eligible | W if eligible | operational assist | A | A | R |
| Extend timer | Visible | Request/W within policy | Request/W | — | W | A | R |
| Override safety gates | — | — | — | — | Limited | A | R |
| Round open/close | — | R | R | R | W | A | R |
| Finalist decision | Own outcome | — | — | — | Recommend | A | R |
| Audit history | Own relevant events | Own events | Panel events | Operational subset | R | R | R |

Exact permissions must be implemented as named capabilities, not hard-coded role checks.

## 5. Capability evaluation

Every protected query and mutation evaluates:

1. valid Clerk/Convex identity;
2. active, non-suspended application user;
3. active event membership;
4. named capability;
5. grant scope (event, round, panel, team, criterion, or venue zone);
6. current entity state and configuration revision;
7. step-up requirement for high-risk actions.

Example capabilities include `team.manage_own`, `queue.declare_ready`, `review.score_assigned`, `panel.start_review`, `ops.manage_queue`, `review_admin.configure_round`, `board.override`, `audit.read`, and `synesthesia.moderate`.

Roles are maintained as bundles for administration, but backend functions authorize capabilities. A board administrator acting as a reviewer receives reviewer capability only for their assigned panel and cannot rely on their broader title to bypass ordinary scoring rules.

## 6. Reviewer profile

A reviewer profile includes:

- Primary organisational role (JC, SC, board, external judge, mentor)
- Verified expertise tags
- Secondary interests
- Criteria they may score
- Track/domain familiarity
- Review training status
- Device readiness
- Availability by round
- Accessibility needs
- Declared team/member conflicts
- Past assignment load for this event
- Current panel and live status

Expertise claims require one of: organiser validation, documented experience, previous work, or training completion. Seniority alone does not produce a score multiplier.

## 7. Visibility boundaries

- Participants can see their own submitted project, review state, queue estimate, published feedback, and final public outcome.
- Reviewers see only teams assigned to their panel, with enough project context to review.
- A reviewer must not see peer scores until their own required scores are submitted and locked. Whether peer scores are ever shown during the round is an open policy decision.
- Private reviewer notes are never participant-visible.
- Published feedback is a separately selected and moderated field.
- Project secrets, private repositories, personal contact details, and sensitive disclosures are restricted to roles with a clear need.
- Synesthesia voters do not expose their vote history publicly.

## 8. Immutability and corrections

- Submitted scores are append-only. A correction creates a new version linked to the replaced score, requires a reason, and preserves the original.
- Review presence, timer events, queue transitions, overrides, and final decisions are append-only events.
- Project profiles remain versioned across registration and review rounds.
- Administrative configuration changes after a round opens create a visible revision and require a reason.
- Hard deletion of event records is prohibited during the retention period, except legally required personal-data erasure handled through an approved redaction process.

## 9. Session and device policy

- Clerk sessions are revocable and short enough to reflect roster and suspension changes.
- Convex authorization always reads current application grants for outcome-affecting writes; a stale client token cannot preserve removed authority.
- Reviewer devices register an installation ID, platform, build/runtime version, notification permission, and last-seen timestamp.
- Tokens stored on device use operating-system protected storage. No Google or Clerk secret is written to general application storage.
- Privileged commands can require recent Google/Clerk re-verification. The re-verification timestamp is checked server-side.
- Push tokens are tied to a device record, rotated when changed, and disabled after provider feedback or logout.
- Shared accounts, shared device PINs, and generic panel logins are prohibited.

## 10. Audit event minimum

Every privileged or outcome-affecting event records:

- event ID and timestamp
- actor user and evaluated capabilities
- action type
- target type and ID
- before/after version or structured diff
- client/device/session reference
- request idempotency key
- reason, if required
- connectivity state and server receipt
- related round, panel, team, and review session

Audit search must support actor, team, panel, round, action type, and time range.

# Domain and access model

## 1. Canonical entities

Every entity has an immutable system identifier, created/updated timestamps, version, status, and audit metadata where applicable.

| Entity | Required meaning |
| --- | --- |
| Person | A human identity with verified contact and event status |
| RoleGrant | A scoped permission granted to a person for the event or a round |
| ReviewerProfile | Expertise, interests, declared conflicts, eligibility, and availability |
| Team | Participant group and public team identity |
| TeamMembership | Person-to-team relationship, role, invitation state |
| ProjectProfile | Versioned project answers, track, evidence links, tools, and disclosures |
| VenueTable | Physical table identifier, zone, and availability |
| TableAssignment | Time-bounded team-to-table association |
| Round | Review phase, schedule, state, timing policy, and elimination policy |
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
| SyncReceipt | Server acknowledgement for a submitted record/version |
| Decision | Elimination, finalist, award, or disqualification record |
| SongRequest | Synesthesia track request |
| SongVote | One person's active vote on a request |
| PlaybackItem | Moderated item in playback history or queue |
| AuditEvent | Append-only record of a security or operational action |

## 2. Identity rules

- One person has one event identity. Duplicate accounts must be mergeable only by an authorised administrator.
- Participant identity must be verified before joining a final team.
- Staff role grants are created from an approved roster, not self-selected.
- A person may hold multiple roles, but every action is evaluated against the narrowest active scope.
- Shared reviewer or administrator accounts are prohibited.
- Privileged sessions require reauthentication according to the security policy.
- A removed or suspended person immediately loses new-write authority; already submitted records remain attributed and immutable.

## 3. Role permissions

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

## 4. Reviewer profile

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

## 5. Visibility boundaries

- Participants can see their own submitted project, review state, queue estimate, published feedback, and final public outcome.
- Reviewers see only teams assigned to their panel, with enough project context to review.
- A reviewer must not see peer scores until their own required scores are submitted and locked. Whether peer scores are ever shown during the round is an open policy decision.
- Private reviewer notes are never participant-visible.
- Published feedback is a separately selected and moderated field.
- Project secrets, private repositories, personal contact details, and sensitive disclosures are restricted to roles with a clear need.
- Synesthesia voters do not expose their vote history publicly.

## 6. Immutability and corrections

- Submitted scores are append-only. A correction creates a new version linked to the replaced score, requires a reason, and preserves the original.
- Review presence, timer events, queue transitions, overrides, and final decisions are append-only events.
- Project profiles remain versioned across registration and review rounds.
- Administrative configuration changes after a round opens create a visible revision and require a reason.
- Hard deletion of event records is prohibited during the retention period, except legally required personal-data erasure handled through an approved redaction process.

## 7. Audit event minimum

Every privileged or outcome-affecting event records:

- event ID and timestamp
- actor person and active role
- action type
- target type and ID
- before/after version or structured diff
- client/device/session reference
- request idempotency key
- reason, if required
- connectivity state and server receipt
- related round, panel, team, and review session

Audit search must support actor, team, panel, round, action type, and time range.


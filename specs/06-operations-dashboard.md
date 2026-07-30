# Operations dashboard

## 1. Purpose

The dashboard is the event control room. It is a role-gated surface of the Next.js web application, backed directly by authorised Convex queries and mutations. Its default view prioritises exceptions and required decisions over decorative aggregate statistics.

## 2. Global command view

At a glance:

- current round and phase
- elapsed time and scheduled boundaries
- teams by queue/review state
- panels complete, incomplete, busy, paused, or offline
- absent/unacknowledged reviewers
- reviews approaching or exceeding time budget
- unsynced or conflicting records
- table-association exceptions
- active pages and substitution attempts
- overrides and safety incidents
- round-close blockers

Every count opens the underlying records.

Counts, lists, and detail drawers must derive from compatible query projections pinned to the same event configuration revision. The dashboard does not poll exported snapshots or require refresh.

## 3. Round setup

Review administrators can:

- create rounds and timing policy;
- choose rubric/configuration version;
- define required panel size and criterion coverage;
- import/approve reviewer roster;
- validate reviewer training and availability;
- generate panel recommendations;
- resolve conflicts and coverage gaps;
- publish panels;
- open table verification;
- generate team-to-panel recommendations;
- simulate queue capacity;
- freeze configuration;
- run readiness checks.

Publishing produces a versioned plan and notifies relevant reviewers.

## 4. Live panels

Panel cards show:

- members and clock-in state
- criterion/expertise coverage
- current/next team
- location
- review duration
- last sync per member
- assignment load
- active conflict, substitution, or help request

Actions are permission-scoped: page, substitute, pause, reassign next team, inspect review, or escalate.

## 5. Queue control

Operations users can:

- verify table/team mappings;
- see readiness and holds;
- assign or approve panel recommendations;
- call a team;
- pause/requeue with reason;
- change priority with reason;
- move work between eligible panels;
- view estimated completion;
- contact participant support.

The system warns before an action creates criterion-coverage gaps, conflicts, duplicate reviews, or severe unfairness in wait order.

## 6. Review inspection

During a live review, authorised users see:

- presence status
- timer and extensions
- required criterion completion status
- sync health
- help/escalation state

They do not see draft score values unless a specifically approved incident role requires it. This avoids influencing active reviewers.

After submission, authorised review administrators can inspect evidence, score versions, coverage, anomalies, and corrections.

## 7. Overrides

An override panel presents:

- blocked rule
- why it exists
- affected team/panel/round
- safer alternatives already attempted
- required authority
- mandatory reason
- expiry/scope
- expected downstream impact

High-risk overrides require explicit confirmation. Examples:

- start with incomplete panel;
- bypass presence proof;
- force assignment despite a warning;
- reopen a locked score;
- reopen/close a round;
- resolve duplicate session;
- mark a team complete despite missing record.

Overrides are visually marked wherever their effects appear.

## 8. Scoring oversight

Views include:

- completion by team, panel, criterion, and reviewer
- missing required input
- distribution and variance
- outlier/anomaly flags
- correction history
- progress commitments
- shortlist/finalist workspace

The dashboard never offers an opaque “normalise scores” button. Any final aggregation uses the frozen documented policy.

## 9. Round close

Close checklist:

- no unaccounted eligible team
- no active review lease
- no unresolved required score
- all submissions acknowledged or formally recovered
- all holds have dispositions
- corrections handled or frozen
- exceptions and overrides reviewed
- export generated and independently validated

Closing locks ordinary writes. Reopening requires board authority and a reason.

## 10. Audit and reporting

Operators can search a chronological event stream and export:

- staffing and attendance
- queue and duration metrics
- assignment decisions
- pages/substitutions
- sync health/incidents
- score completion and revisions
- overrides and round decisions

Participant-facing feedback is generated only from explicitly approved fields.

## 11. Realtime command contract

- Each panel, queue, review, incident, and round-control screen has a narrowly scoped reactive query.
- A command button calls one named mutation and carries a `clientMutationId`, expected version, target IDs, and reason when required.
- The mutation re-evaluates capability and state; disabling a button in the browser is only a usability aid.
- The UI shows `pending` until the server receipt arrives, then lets subscribed query results render the committed truth.
- Retrying the same command returns the original receipt.
- A transport failure after send is resolved by looking up the command receipt, not by guessing whether the write happened.
- Large aggregate views use maintained projections/counters where measurement proves they are necessary; they do not subscribe every operator to every raw record.

## 12. Acceptance criteria

- An operator can locate any team, reviewer, panel, or table in three interactions or fewer.
- Critical exceptions appear without refreshing.
- Every mutating command previews its target and reports success/failure.
- Commands are idempotent; repeated clicks do not duplicate assignments or pages.
- The dashboard cannot conceal round-close blockers.
- Overrides are searchable and included in exports.
- Draft peer scores are not exposed during active review by default.
- Two operators issuing conflicting commands receive one serializable outcome and one actionable conflict response.
- A reviewer-app command and participant-portal command become visible to authorised dashboard subscriptions without integration jobs.

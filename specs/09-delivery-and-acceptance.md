# Delivery and acceptance

## 1. Delivery sequence

The technology baseline is selected. Product-policy decisions remain configuration and launch gates; they do not block creation of the shared identity, schema, authorization, realtime, audit, and deployment foundations.

### Milestone 0: Platform foundation and policy lock

Deliver:

- pnpm/Turborepo repository with `apps/web`, `apps/reviewer`, `packages/domain`, `packages/ui`, and `convex`
- isolated development, staging, and production Clerk/Convex/Vercel/EAS environments
- Google-only Clerk authentication on Next.js and Expo
- VIT Student/External auth-intent flow and server-side Google `hd` verification
- Convex schema, indexes, auth configuration, capability guard, command-receipt helper, domain-event helper, and audit helper
- reactive client providers and connection/sync indicators on web and mobile
- reviewer device registration, secure token storage, encrypted draft/outbox skeleton, and push-token lifecycle
- error reporting, release identifiers, structured logs, and baseline dashboards
- CI typecheck, lint, unit, Convex function, web E2E, and mobile smoke-test jobs
- approved rubric and aggregation method
- team-size policy
- round/elimination model
- panel size and criterion coverage
- timing/extension rules
- visibility and correction policy
- degraded-mode authority
- data retention policy

Exit: a VIT student and external test user can authenticate; a rostered reviewer can authenticate on mobile; a test mutation appears live on web and mobile; unauthorized writes fail in Convex; environment and policy blockers have owners.

### Milestone 1: Identity, teams, and project onboarding

Deliver participant identity, team membership, guided project profile, submission receipts, and organiser shortlisting.

Exit: full registration journey and permissions pass acceptance tests.

### Milestone 2: Venue identity and table operations

Deliver check-in, team QR, table assignment/confirmation, staff exceptions, and participant review status shell.

Exit: simulated venue check-in and table sweep succeeds.

### Milestone 3: Reviewer and panel foundation

Deliver reviewer profiles, criterion grants, training state, availability, panels, conflicts, clock-in, paging, and substitution.

Exit: staffing drill can replace absences while preserving coverage.

### Milestone 4: Queue and review execution

Deliver readiness, assignments, queues, presence scanning, session lease, timer/extensions, evidence, independent scoring, receipts, and completion.

Exit: concurrent mock round completes without duplicate or missing sessions.

### Milestone 5: Scoring oversight and round close

Deliver aggregation, anomalies, progress tracking, corrections, finalist workspace, close checklist, and validated exports.

Exit: two independent exports reproduce the same results.

### Milestone 6: Reliability and event rehearsal

Deliver monitoring, backups, recovery, degraded mode, support, incident tooling, and accessibility fixes.

Exit: full-scale rehearsal and failure drills meet launch gates.

### Milestone 7: Synesthesia

Independent delivery after core review operations are safe. It must never compete with or impair review traffic and operations.

## 2. Required test environments

- Local development with generated identities and deterministic seed data
- Shared development deployment with no real participant data
- Staging/reviewer-training environment with production-like Google, Clerk, Convex, push, and EAS configuration
- Operations rehearsal environment or namespaced rehearsal event in staging
- Production-like load environment with synthetic accounts and isolated notification targets
- Recovery/restore environment

Configuration promotion is versioned and auditable.

No environment shares Clerk users, Convex records, Google OAuth credentials, Vercel secrets, Expo push credentials, or backup destinations with another environment unless the exception is documented and approved.

## 3. Core end-to-end scenarios

1. Participant creates a valid team, completes guided onboarding, and receives submission receipt.
2. Team checks in, moves tables once, and sees the correct QR and queue status.
3. All reviewers clock in, scan presence, complete independent criteria, and finish a review.
4. One reviewer is absent and a qualified substitute accepts a page.
5. A conflict is discovered before and during a review.
6. A team is not ready; queue proceeds and team later re-enters fairly.
7. A review uses permitted extensions and concludes with justification.
8. A reviewer loses connection while drafting and later receives a valid receipt without duplication.
9. Two clients try to start the same team review; only one lease succeeds.
10. A device dies after acknowledged saves; another device recovers the work.
11. An administrator performs and later audits an override.
12. A round attempts to close with a missing criterion and is blocked.
13. Review 2 compares declared commitments against demonstrated progress.
14. An export is generated, restored from backup, and independently reproduced.
15. Synesthesia handles duplicate request, vote removal, moderation, playback override, and fallback.

## 4. Load model

The final load plan must use confirmed registration and staffing numbers. It should include:

- 1,000 participants checking queue state near round start
- all panels clocking in within a short window
- burst QR scans at many tables
- concurrent review drafts and score submissions
- notification/page bursts during substitution
- dashboard live updates
- partial network degradation

Success thresholds for latency and error rate are validated and frozen before the full-scale rehearsal. Data correctness is a harder gate than visual responsiveness.

Working technical gates for rehearsal:

- accepted command p95 ≤ 750 ms and p99 ≤ 2 s under the approved synthetic load;
- accepted-command-to-online-subscriber p95 ≤ 1.5 s;
- zero duplicate active review sessions, score submissions, or queue entries;
- 100% of acknowledged critical commands resolvable by command receipt;
- dashboard critical projection age ≤ 5 s while connected;
- push ticket creation p95 ≤ 5 s, with delivery receipt processing and an in-app/operations fallback;
- a client reconnect restores current authoritative projections without manual refresh.

## 5. Operational drills

Run at least:

- absent-reviewer drill
- wrong-table drill
- connectivity-loss drill
- duplicate-session drill
- corrupted/failed client update drill
- notification failure drill
- backup restore drill
- unsafe-conduct escalation drill
- round-close reconciliation drill

Each drill records observed time, confusion, data state, and runbook changes.

## 6. Training

### Reviewers

- rubric and evidence anchors
- independent scoring and anti-anchoring
- conflicts
- app practice
- timer and extension policy
- connectivity and device recovery
- participant conduct

### Operations

- table verification
- queues and holds
- paging/substitution
- safe commands and permissions
- incident escalation

### Board/review administrators

- configuration lock
- overrides
- anomaly review
- correction and appeals
- round close and exports

## 7. Definition of done

A feature is done only when:

- product rules and edge cases are implemented;
- permissions and audit events exist;
- loading, empty, error, offline, and recovery states exist;
- accessibility requirements pass;
- metrics and alerts exist;
- automated tests cover invariants;
- runbook and operator ownership exist;
- representative users complete rehearsal;
- no unresolved critical or high-severity defect remains.
- schema and function changes remain backward-compatible with the supported mobile runtime or are protected by a coordinated minimum-version gate.
- every new external side effect is outbox-driven, retryable, observable, and idempotent.

## 8. Event launch checklist

- Configuration frozen and checksum recorded
- Staff roster and backups confirmed
- Reviewer training eligibility locked
- Supported app version enforced
- Participant communications published
- Venue tables and labels verified
- Notification and QR smoke tests passed
- Backup/restore and exports verified
- Incident channel and command roles staffed
- Manual fallback materials controlled
- Round 1 dashboard dry run complete
- Final go/no-go recorded by named owners

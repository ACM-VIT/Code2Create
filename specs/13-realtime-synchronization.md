# Realtime synchronization

## 1. Contract

“Fully realtime” means:

- portal, reviewer app, and operations dashboard observe authorised views of the same committed Convex state;
- connected clients receive relevant changes automatically through reactive query subscriptions;
- every write is validated and serialized at the backend;
- reconnecting clients recover current truth without replaying other clients’ messages;
- offline drafts never masquerade as accepted event state;
- push notifications attract attention but never define truth.

It does not mean every keystroke is broadcast or every user subscribes to the full event database.

## 2. Authoritative change pipeline

```text
user action
  → client creates stable clientMutationId
  → Convex mutation authenticates and authorizes
  → state/version/invariant checks
  → canonical write + receipt + domain/audit event + outbox job
  → transaction commits
  → mutation result returns receipt
  → affected reactive queries recompute
  → authorised online clients render new projections
  → scheduled worker performs any external notification
```

There is no intermediate event bus that clients must reconcile with the database. Domain events support audit, integrations, and derived work; canonical records remain the read truth.

## 3. Subscription design

Queries are shaped around a screen or operational task.

### Participant

| Query | Contains | Excludes |
| --- | --- | --- |
| `viewer.me` | user, event membership, account class, capabilities, onboarding state | provider tokens, roster internals |
| `portal.teamHome` | team, members, project completion, check-in, current table | private reviewer data |
| `portal.queueStatus` | participant-safe state, teams ahead/window, preparation, hold explanation | private panel absence/conflict details |
| `portal.reviewProgress` | published stage/completion/feedback | draft scores and private notes |
| `synesthesia.participantQueue` | eligible requests, aggregate votes, playback state | voter identities and moderation notes |

### Reviewer

| Query | Contains | Excludes |
| --- | --- | --- |
| `reviewer.now` | current round instruction, active page, assignment, location, deadline | unrelated teams |
| `reviewer.panel` | member readiness, coverage, current/next work | private absence/conflict explanations |
| `reviewer.activeSession` | current team context, evidence, own draft/submission state, presence, timer | peer score values before reveal |
| `reviewer.history` | own completed assignments and receipts | other panels’ review data |

### Operations

| Query | Contains |
| --- | --- |
| `ops.commandSummary` | round phase, exception counts, projection timestamps, blockers |
| `ops.queueBoard` | scoped queue entries, teams, tables, panels, holds, windows |
| `ops.panelBoard` | members, readiness, coverage, pages, last sync, current review |
| `ops.reviewDetail` | presence, timer, required completion, sync health, incidents |
| `scoring.roundCompletion` | submitted coverage, missing data, locked anomalies, close blockers |
| `audit.search` | paginated permitted event stream, never a live unbounded subscription |

Every query:

- requires an authenticated identity unless explicitly public;
- resolves event and capabilities;
- uses indexed reads;
- returns the minimum projection;
- redacts sensitive fields at the server;
- has a bounded result size or pagination strategy.

## 4. Propagation matrix

| Accepted command | Portal | Reviewer app | Operations |
| --- | --- | --- | --- |
| `teams.submitProject` | receipt/version updates | future assigned context changes | shortlisting queue changes |
| `tables.assignTeam` | table/QR changes | active assignment location changes | table conflicts/capacity change |
| `queues.declareReady` | ready/queued state | eligible panel next-work changes | queue counts/order change |
| `reviewers.clockIn` | no private detail | panel status changes | absence/readiness changes |
| `pages.accept` | panel-arriving when publishable | active instruction changes | substitution resolves |
| `presence.verify` | arrival state changes | panel presence changes | review readiness changes |
| `reviews.start` | in-review state | workspace/timer activates | lease/active-review changes |
| `reviews.extend` | estimated completion changes | all panel timers change | overrun metrics change |
| `scores.submitOwn` | no score value | own receipt/completion changes | coverage blocker changes |
| `reviews.complete` | submitted/complete changes | assignment moves to history | queue and round blockers change |
| `rounds.close` | outcome/published state changes | round becomes read-only | controls and exports change |

An accepted command may intentionally not update a client when policy hides the information.

## 5. Idempotent commands

Each mutating client action creates one UUID/ULID `clientMutationId` and retains it until a definitive receipt or rejection.

Server behavior:

1. look up `(actorUserId, clientMutationId)`;
2. if absent, validate and execute;
3. store request hash and safe result in `commandReceipts`;
4. if present with the same hash, return the original result;
5. if present with a different hash, reject as `IDEMPOTENCY_KEY_REUSED`.

Buttons may be tapped twice, mobile may retry after timeout, and networks may lose a response. None may create duplicate pages, scores, queue moves, or extensions.

## 6. Version and configuration checks

Commands include only the versions they depend on:

- `expectedVersion` for the primary mutable aggregate;
- `configRevisionId` for policy meaning;
- `assignmentRevision` for routing/queue commands;
- `leaseEpoch` for active review/playback commands;
- `rubricVersionId` for scoring;
- supported `commandSchemaVersion`.

Mismatch responses contain:

- stable error code;
- current safe version;
- whether automatic refresh/retry is allowed;
- human-readable resolution;
- correlation ID.

The client refreshes its subscription and asks the user to reconsider when intent could have changed. It never resubmits a critical command against a newer version without confirmation.

## 7. Concurrency

Convex mutations provide the serializable transaction boundary. Product logic still makes conflicts understandable.

### Review lease

- `reviews.start` checks team/round uniqueness and all readiness invariants.
- It increments `leaseEpoch` and sets holder/expiry.
- Only the current epoch may add live presence, timer, evidence, scores, or completion.
- The active app renews a lease on a controlled cadence through an idempotent command.
- Expiry creates an operations exception; it does not automatically allow another panel to overwrite work.
- Recovery either restores the same holder/epoch or explicitly advances to a new epoch and records disposition.

### Queue ordering

- Canonical `orderingKey` belongs to the server.
- Move/reprioritize commands describe intent: before/after entry or priority class.
- The mutation computes affected keys and records a reason.
- Participant ordinal/window is a projection, not client data.

### Score submission

- Each reviewer submits only their granted criteria.
- A submission group is validated and written atomically.
- A second initial submission resolves to the existing receipt or becomes an explicit correction flow.
- Peer score reveal is a server policy projection, not a client toggle.

### Panel substitution

Page acceptance, substitution attempt, old membership disposition, new membership, criterion coverage, and notifications update in one mutation.

## 8. Optimistic UI policy

Optimistic rendering is allowed only when reversal is harmless and the server rule is simple.

| Action | Optimistic? | Reason |
| --- | --- | --- |
| Open/close local panel | Yes | UI-only |
| Edit unsent onboarding answer | Yes/local | Draft, no external authority |
| Synesthesia vote | Yes with rollback | Low-risk and idempotent |
| Declare ready | Pending state only | Queue policy may reject |
| Accept substitution page | No | Candidate race and coverage |
| Verify presence | No | Security/QR/lease checks |
| Start review | No | Unique lease |
| Submit scores | No success state before receipt | Outcome-affecting |
| Extend timer | No | Shared timer and policy |
| Override/round close | No | High-risk authority |

For critical actions the button may immediately show “Sending,” but the domain state changes only when the mutation result/subscription confirms it.

## 9. Reviewer offline outbox

The reviewer app supports offline drafting, not offline authority.

### Stored locally

- assigned context needed to understand the current task;
- own draft evidence, notes, criterion values, and rationale;
- command envelope with ID, schema version, session, lease epoch, expected version, timestamps;
- acknowledgement state.

### Not stored locally

- peer scores;
- unrestricted participant directory;
- Google ID/access tokens;
- administrator exports;
- durable QR signing secrets;
- another reviewer’s draft.

### Protection

- payload encrypted using an installation key in SecureStore/Keychain/Keystore;
- local database never used as a shared account store;
- device revoke/logout stops sending and removes keys after acknowledged records are handled;
- screens hide sensitive drafts in OS task-switcher previews where supported.

### Reconnect algorithm

1. Re-establish Clerk and Convex authentication.
2. Subscribe to current authoritative assignment/session.
3. Resolve each queued command by command receipt.
4. Purge already accepted commands.
5. For unsent commands, compare session, lease epoch, config, and versions.
6. Automatically send only when still valid and policy allows.
7. Mark stale/conflicting records `needs_attention`.
8. Present a readable reconciliation screen; never silently drop.

Final score submission ordinarily requires online server acknowledgement. An incident-mode manual workflow is a separate, explicitly activated policy.

## 10. Timers

The server records authoritative timer events. Clients render a smooth countdown from:

- last server event timestamp;
- accumulated active duration;
- budget plus granted extensions;
- locally measured clock drift.

The UI can animate every second without a database write every second. Start, pause, resume, extension, stop, and correction are server events. Reconnecting clients recompute the same timer from those events.

If device and server time differ beyond threshold, the client displays server-derived time and reports telemetry.

## 11. Presence and QR

The portal requests a short-lived signed QR reference scoped to team, round, current assignment revision, and presence action.

On scan:

1. reviewer app sends token, reviewer identity, active assignment, device, and command ID;
2. server verifies signature/expiry/scope;
3. server validates panel membership, conflict, session/assignment revision, and replay state;
4. mutation records reviewer presence and receipt;
5. all panel apps, participant portal, and operations projection update according to visibility.

QR contents never directly mark presence on a client and never include personal data.

## 12. Push notification contract

Use push for:

- reviewer page/substitution;
- urgent assignment/location change;
- round clock-in reminder;
- active review incident escalation;
- supported-app-version/security notice.

Do not use push for:

- continuous timer synchronization;
- canonical queue ordering;
- score confirmation;
- proof that a reviewer accepted;
- silent high-volume data synchronization.

Each notification:

- refers to a server record ID or safe route, not embedded authority;
- has a dedupe/collapse key;
- has expiry aligned to operational usefulness;
- is stored as a notification job/delivery;
- opens a route that subscribes to fresh state;
- requires an authenticated acknowledgement mutation when acknowledgement matters.

Provider tickets and receipts are observed, invalid tokens are disabled, and critical unacknowledged pages become operations exceptions with escalation.

## 13. Connection states

All live surfaces expose an honest state:

| State | Meaning | Critical writes |
| --- | --- | --- |
| Live | subscription healthy; recent server result | allowed |
| Reconnecting | transport interrupted; reconnect active | pending/blocked by risk |
| Stale | cached projection older than threshold | blocked where authority matters |
| Offline draft | protected local draft available | draft only |
| Unsupported client | build/runtime below policy | blocked except update/help |
| Incident mode | named fallback activated | only commands allowed by incident policy |

“Live” requires a recent Convex connection and current projection, not merely network reachability.

## 14. Projection performance

Guidelines:

- filter by `eventId`, scope, status, and bounded window using indexes;
- paginate history and audit;
- avoid per-row queries in loops;
- split fast-changing timer/presence state from large static project context when needed;
- return IDs/fields required by the screen only;
- avoid subscribing all operators to all private score documents;
- use maintained counters only for proven expensive summaries;
- shard high-write synthetic sequence/counter needs rather than creating one event-global hot document;
- measure invalidation and payload size in rehearsal.

## 15. Working service objectives

Measured in staging rehearsal and production:

| Measure | Working objective |
| --- | --- |
| Accepted command latency | p95 ≤ 750 ms, p99 ≤ 2 s under approved venue load |
| Commit to online subscriber render | p95 ≤ 1.5 s |
| Critical dashboard projection freshness | ≤ 5 s while connected |
| Ambiguous accepted command resolution | 100% resolvable through receipt |
| Duplicate active review sessions | 0 |
| Acknowledged score loss | 0 |
| Reconnect to current scoped state | p95 ≤ 5 s after network availability |
| Page job creation | p95 ≤ 5 s; delivery itself has provider-dependent monitoring/fallback |

Push delivery has no hard end-to-end guarantee from the application. The operational guarantee is detection, acknowledgement tracking, and fallback.

## 16. Realtime acceptance tests

1. Participant declares ready; two dashboard clients and assigned reviewer update without refresh.
2. Two panels start the same team concurrently; one lease wins.
3. Operator reassigns a queued team; old panel loses actionable state and new panel gains it.
4. Reviewer accepts a page on one device; duplicated push on another cannot accept again.
5. Device loses response after score submission; restart retrieves the original receipt.
6. Device drafts offline; another panel takes a new lease; reconnect marks old draft stale.
7. Reviewer grant is revoked while app is open; next sensitive mutation fails and subscribed UI loses controls.
8. Round config changes in draft do not affect an open round pinned to an older revision.
9. 1,000 participant subscriptions observe queue-window updates without seeing private panel data.
10. Push is disabled on a reviewer device; operations sees the condition and uses fallback.
11. Synesthesia vote burst does not breach core review command objectives.
12. Dashboard disconnects for five minutes and reconnects directly to current truth without replay gaps.

# Technical architecture

## 1. Architecture decision

Code2Create 7.0 is a TypeScript monorepo with:

- one Next.js web application for the participant portal and role-gated staff/operations surfaces;
- one Expo React Native application for reviewers;
- Clerk for Google-only authentication across web and mobile;
- Convex as the single realtime backend and authoritative application database;
- Expo Notifications for reviewer paging;
- Vercel and EAS for web/mobile delivery;
- Sentry plus application-owned domain/audit events for observability.

This is the implementation baseline. It is detailed enough to begin schema, auth, vertical-slice, and infrastructure work while event-policy values remain configurable.

## 2. Why this shape

The hard problem is not rendering three interfaces. It is maintaining one fair, observable review operation while hundreds of clients change assignments, presence, queues, timers, evidence, and scores.

The selected shape removes a custom synchronization tier:

- Convex mutations provide the transactional write boundary.
- Convex reactive queries update authorised clients from one consistent database snapshot.
- Clerk provides one identity/session model that works with Next.js, Expo, and Convex.
- The mobile app uses the same generated Convex API as the web app.
- Push is reserved for background attention; foreground state comes from subscriptions.
- Shared TypeScript domain packages prevent three clients from inventing different statuses or labels.

## 3. System topology

```text
                         Google Identity / Workspace
                                    |
                                  Clerk
                    session + Convex-compatible JWT
                         /                      \
                Next.js web                Expo reviewer
          participant + operations          Android / iOS
                         \                      /
                          Convex React clients
                                    |
                                Convex cloud
               queries · mutations · actions · scheduled jobs
               application records · files · domain/audit events
                         /                      \
             Expo Push Service            Backup/export store
                  FCM / APNs              outside live deployment
```

No browser-to-mobile, mobile-to-dashboard, or dashboard-to-portal synchronization endpoint exists. Each client authenticates independently, subscribes to its authorised projections, and sends commands to the same backend.

## 4. Application surfaces

### 4.1 `apps/web`

Next.js App Router application containing:

- public event information and registration entry;
- VIT Student/External selector and Google auth continuation;
- participant onboarding, team, project, check-in, queue, review history, and Synesthesia;
- reviewer/staff invitation acceptance where a browser flow is useful;
- operations command centre;
- review-administrator configuration and scoring oversight;
- board override/finalist workspace;
- auditor read-only search and exports.

The web application is one deployment with route groups and capability-gated navigation. Participant and administration layouts may differ, but they share the same session provider, generated API, domain package, and backend.

Next.js server components handle public/initial shells and server-guarded routes. Live operational screens use client components with Convex reactive hooks. Authorization is always repeated inside Convex functions.

### 4.2 `apps/reviewer`

Expo React Native application containing:

- Google authentication and roster resolution;
- device/notification readiness;
- round clock-in and availability;
- substitution pages and acknowledgement;
- panel status;
- QR scanner and presence confirmation;
- active review workspace, timer, evidence, criteria, notes, and commitments;
- independent score submission and receipts;
- encrypted local draft/outbox recovery;
- conflict, safety, device, and connectivity support.

Android is the first operational priority because event reviewers are likely to use personal Android devices, but iOS remains a supported build. Native capability changes require an EAS build; compatible JavaScript fixes can use a controlled EAS Update channel.

### 4.3 `convex/`

Convex contains the complete backend:

- `schema.ts` and index definitions;
- `auth.config.ts` for Clerk token validation;
- public role-filtered queries;
- public command mutations;
- server-only internal queries/mutations/actions;
- external actions for Google verification, push delivery, export upload, and approved integrations;
- scheduled retry, expiry, reconciliation, and health jobs;
- shared capability, validation, state-machine, receipt, audit, and event helpers.

Clients do not write database documents directly. A public mutation represents a domain command such as `queues.declareReady`, not CRUD such as `updateQueueEntry`.

## 5. Repository layout

```text
code2create/
├── apps/
│   ├── web/
│   │   ├── app/
│   │   ├── components/
│   │   ├── features/
│   │   └── tests/
│   └── reviewer/
│       ├── app/
│       ├── components/
│       ├── features/
│       ├── storage/
│       └── tests/
├── convex/
│   ├── auth.config.ts
│   ├── schema.ts
│   ├── auth/
│   ├── teams/
│   ├── reviewers/
│   ├── panels/
│   ├── queues/
│   ├── reviews/
│   ├── scoring/
│   ├── operations/
│   ├── synesthesia/
│   ├── notifications/
│   ├── audit/
│   └── lib/
├── packages/
│   ├── domain/
│   ├── ui-web/
│   ├── ui-native/
│   ├── config/
│   ├── observability/
│   └── test-factories/
├── tooling/
├── turbo.json
├── pnpm-workspace.yaml
└── package.json
```

### Package boundaries

`packages/domain` may contain:

- shared enums and display labels;
- pure state-transition helpers;
- score-scale and rubric types;
- command/result types that do not duplicate generated Convex types;
- time, identifier-display, and policy utilities;
- no React, database access, secrets, or vendor SDK.

Web and native UI stay separate because DOM and React Native primitives differ. Share design tokens and domain language, not incompatible components.

The `convex/` folder may import pure domain code only when it is supported by the runtime and does not pull client dependencies. Generated Convex API and data-model types remain the source for backend-call typing.

## 6. Identity request path

### Participant registration

1. Web asks VIT Student or External Participant.
2. A server command creates a short-lived auth intent with class, nonce, safe return path, and browser binding hash.
3. Clerk starts Google authentication.
4. After session creation, web calls the provisioning action with the intent nonce.
5. Server retrieves the Google OIDC ID token through the Clerk backend connection.
6. Server verifies Google signature, issuer, audience, expiry, `sub`, verified email, and—on VIT path—`hd`.
7. A mutation consumes the intent and creates/links the application user, identity link, event membership, profile draft, and audit event atomically.
8. The client subscribes to `viewer.me` and continues onboarding.

The external Google token is handled only in a server action and is never stored in application tables or returned to clients.

### Returning user

Clerk authenticates, Convex resolves `identity.subject` to `users.clerkSubject`, and `viewer.me` returns active event context, account class, profile state, capabilities, and next route.

### Staff/reviewer

The same Google identity is matched to a pre-approved roster entry by stable identity where available or a verified normalized email during first claim. Claiming consumes the roster invitation and creates scoped grants. Subsequent authorization uses internal user and grant IDs, not an email comparison.

## 7. Read path

1. Client obtains a Clerk session token accepted by Convex.
2. Client subscribes to a public Convex query such as `reviewer.now`.
3. Query resolves current user and active grants.
4. Query reads only records needed for that surface and returns a minimal, redacted projection.
5. Convex tracks dependencies.
6. A relevant committed mutation causes Convex to recompute and push the new projection.

Queries never return raw tables, Google/Clerk identifiers, private peer scores, hidden conflicts, or unneeded personal data.

## 8. Write path

Every outcome-affecting public mutation follows the same order:

1. validate arguments with Convex validators;
2. require authenticated user;
3. resolve active event and current grants;
4. require named capability and scope;
5. check event/configuration revision and entity expected version;
6. check state-machine transition and business invariants;
7. resolve `clientMutationId`;
8. if receipt already exists, return the previous result;
9. write domain documents;
10. write append-only domain and audit events;
11. write notification/export outbox jobs when required;
12. write command receipt;
13. return the receipt and new versions.

Steps 2–12 execute inside one Convex mutation transaction. Third-party network calls never execute inside the mutation.

## 9. External side effects

Convex actions are used only when nondeterministic I/O is required:

- verifying the Google OIDC token during initial provisioning;
- sending Expo push batches;
- checking push receipts and disabling dead tokens;
- producing/uploading signed exports;
- optional repository metadata fetches;
- approved email/SMS fallback integration.

The initiating mutation stores an outbox job first. A scheduled internal action claims the job, performs I/O, then records a delivery attempt through an internal mutation. Retries use the same idempotency/dedupe key.

## 10. Realtime boundary

Reactive queries are organized by user task, not entity table:

- `portal.home`
- `portal.onboarding`
- `portal.queueStatus`
- `reviewer.now`
- `reviewer.panel`
- `reviewer.activeSession`
- `ops.commandSummary`
- `ops.queueBoard`
- `ops.panelBoard`
- `ops.reviewDetail`
- `scoring.roundCompletion`
- `synesthesia.participantQueue`
- `synesthesia.playbackControl`

This reduces data exposure and unnecessary invalidation. Large command-centre totals may use transactionally maintained projection documents after profiling; correctness remains traceable to canonical records.

## 11. Client state

| Kind | Owner | Examples |
| --- | --- | --- |
| Authoritative domain state | Convex | queue entry, panel membership, presence, lease, submitted score, round state |
| Authentication session | Clerk | signed-in user, session token, re-verification state |
| Reactive server projection | Convex client cache | current queue status, panel readiness, active review |
| Ephemeral UI state | React | open drawer, selected tab, unsent field focus |
| Recoverable local draft | reviewer encrypted SQLite outbox | evidence/note/score draft and pending command |
| Device secret | SecureStore/Keychain/Keystore | outbox encryption key, protected token cache |
| Background attention | Expo push/APNs/FCM | “substitution page available” hint |

Do not mirror Convex collections into a client-owned normalized store. Use local persistence only for recovery cases named in the offline contract.

## 12. Configuration model

Policy is data, but not casually editable data.

- `eventConfigs` stores immutable published revisions.
- A draft configuration can be edited until publication.
- Rounds reference exact config, rubric, timing, and queue-policy versions.
- Mobile/web clients receive the required minimum app/runtime version with the config.
- Changing a published rule creates a new revision, reason, approver, audit event, and compatibility check.
- A round cannot silently move to another revision after opening.

This allows open policy decisions to be completed without rebuilding clients while preventing mid-round drift.

## 13. Security boundaries

- Google authenticates the upstream account.
- Clerk owns application sessions.
- Convex verifies Clerk tokens and authorizes every backend call.
- Role metadata in the browser/mobile session is advisory; current grants are read server-side for sensitive writes.
- Google/Clerk secrets, Google ID tokens, export credentials, Sentry auth tokens, and push service credentials are server-only.
- Only publishable Clerk keys and Convex deployment URLs may be in client bundles.
- QR codes contain a signed, short-lived, action-scoped reference—not a user, score, or durable credential.
- Reviewer local drafts are encrypted; logout/revocation removes the device key after safe outbox handling.
- PII and private review content are separated from participant/public projections.

## 14. Observability

Every client/build includes environment, release, runtime version, device/app identifier, and correlation ID in error reports without leaking score text or personal data.

Core telemetry:

- Clerk/Google auth conversion and failure categories;
- mutation latency, validation/conflict errors, and idempotent retries;
- query subscription count, disconnects, reconnects, and projection age;
- active lease age and renewal failure;
- notification outbox age, attempts, tickets, receipts, and acknowledgements;
- queue transition and review-duration metrics;
- round-close blockers;
- unsupported mobile builds;
- audit-event write health.

Sentry handles technical errors and performance. Convex domain/audit tables handle business history. Neither substitutes for the other.

## 15. Testing architecture

### Unit

- state machines;
- capability/scope evaluation;
- queue ordering;
- criterion coverage;
- aggregation against frozen fixtures;
- identity-claim validation;
- redaction/projection helpers.

### Backend integration

- Convex functions with authenticated identities;
- transaction and idempotency behaviour;
- competing review lease starts;
- roster claim;
- score visibility;
- round-close invariants;
- outbox retry and receipt handling.

### Web

Playwright tests participant onboarding and operations paths against a seeded test deployment.

### Mobile

React Native component tests cover interaction logic. Maestro runs critical device flows: Google test login, notification-open, QR scan fixture, offline draft, reconnect, submission receipt, and app restart.

### Rehearsal/load

A purpose-built synthetic client drives real Convex queries/mutations against an isolated load deployment. It models round-start subscription bursts, QR scans, reviewer writes, queue moves, pages, and reconnects.

## 16. Constraints and explicit non-choices

- No independent REST database service between clients and Convex.
- No Firebase/Firestore mirror.
- No direct database writes from Next.js route handlers.
- No polling loop as the normal synchronization mechanism.
- No email address as a primary key.
- No client-trusted role or VIT classification.
- No push-only assignment workflow.
- No last-write-wins for review, queue, score, override, or round state.
- No service worker or mobile background task that can finalize an authority transition without a current server receipt.
- No microservices until measured scale or isolation needs justify them.

## 17. Official implementation references

- [Convex realtime queries](https://docs.convex.dev/realtime)
- [Convex React client and WebSocket behavior](https://docs.convex.dev/client/react/overview)
- [Convex and Clerk integration](https://docs.convex.dev/auth/clerk)
- [Convex transaction atomicity and serializability](https://docs.convex.dev/database/advanced/occ)
- [Google OpenID Connect claims and hosted-domain validation](https://developers.google.com/identity/openid-connect/reference)
- [Clerk Expo Google sign-in](https://clerk.com/docs/expo/guides/configure/auth-strategies/sign-in-with-google)
- [Expo push notifications](https://docs.expo.dev/push-notifications/overview/)
- [Next.js App Router](https://nextjs.org/docs/app)

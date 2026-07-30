# Infrastructure and delivery

## 1. Stack inventory

### Language and repository

- TypeScript with strict mode
- Node.js active LTS supported by selected Next.js/Convex tooling
- pnpm workspaces
- Turborepo task graph/cache
- ESLint and Prettier
- Changesets only if internal packages need explicit release/versioning; otherwise lockstep repository revisions

All production dependency versions are pinned in `pnpm-lock.yaml`. “Latest” is never resolved during a production build.

### Web

- Next.js App Router
- React
- Clerk Next.js SDK
- Convex React/Next.js integration
- accessible headless primitives only where they reduce risk
- CSS variables plus a small internal web UI package
- React Hook Form/Zod only for client form ergonomics; Convex validators remain backend authority
- Playwright

The operations dashboard and participant portal deploy as one Vercel project, with capability-gated routes and separate layouts.

### Reviewer mobile

- Expo and React Native
- Expo Router
- Clerk Expo SDK with native/browser Google flow as approved per platform
- Convex React client
- Expo Camera
- Expo Notifications
- Expo SecureStore
- Expo SQLite
- Expo Updates
- Sentry Expo/React Native SDK
- Maestro for device E2E

Use development builds from the start because Google native auth, push, and full device capability cannot be validated reliably in Expo Go.

### Backend

- Convex schema, database, reactive functions, actions, file storage, scheduler/cron
- Clerk JWT verification in `convex/auth.config.ts`
- Google token verification library in server action/runtime
- Expo server SDK or direct Expo Push API from internal actions
- Sentry-compatible backend error reporting where supported
- deterministic export generation

### Quality

- Vitest
- Testing Library for React/React Native
- Convex function testing
- Playwright
- Maestro
- axe-based automated accessibility checks plus manual screen-reader/device review
- k6 or purpose-built TypeScript load driver for HTTP/auth entry points and a Convex-aware synthetic client for subscription/mutation load

## 2. Environments

Maintain three permanent environments:

| Environment | Use | Data |
| --- | --- | --- |
| Development | daily engineering and feature branches | generated/non-sensitive |
| Staging | integrated QA, reviewer training, full rehearsal | synthetic or explicitly approved rehearsal data |
| Production | registration and live event | real data |

Each has independent:

- Clerk instance and issuer;
- Google OAuth web/iOS/Android credentials;
- Convex deployment and data;
- Vercel project/environment;
- Expo/EAS environment variables and update channels;
- push credentials/tokens;
- Sentry environment;
- backup prefix/bucket and encryption context;
- webhook secrets and signing keys.

Production clients reject staging issuers/deployments and vice versa.

Ephemeral web previews may use a shared development backend only when visibly labelled and unable to write real data. Backend schema/function changes use a dedicated preview/test deployment when they could conflict.

## 3. Deployment topology

### Web

Vercel:

- preview deployment on pull request;
- staging deployment from protected `staging` branch/tag policy;
- production deployment from protected release commit;
- environment variables managed in Vercel, never repository;
- custom domains and exact Clerk redirect URLs;
- deployment release ID forwarded to Sentry and audit metadata.

### Backend

Convex:

- development deployment for local/shared dev;
- staging deployment promoted and seeded through controlled scripts;
- production deployment from the same reviewed commit as web/mobile API compatibility;
- schema/function deploy before compatible client release;
- migration jobs tracked and observed;
- no manual production function edits outside version control.

### Mobile

EAS:

- development profile for internal engineering devices;
- preview profile/channel for QA and reviewer training;
- production profile/channel for event builds;
- Android application ID and iOS bundle ID fixed early;
- credentials owned by the event organization, not a personal account;
- internal distribution for rehearsal;
- store/internal production distribution decided before launch;
- EAS Update limited by runtime compatibility and channel.

Native changes require a new build. JavaScript/asset changes may use EAS Update only after staging verification and rollback plan.

## 4. Configuration and secrets

### Public client configuration

Safe to embed:

- Clerk publishable key;
- Convex deployment URL;
- Sentry DSN with server-side filtering/rate policy;
- environment label;
- app/release/runtime version;
- public event slug;
- Google native OAuth client IDs where SDK/platform requires them.

`EXPO_PUBLIC_*` values are public by definition.

### Server-only secrets

- Clerk secret key;
- Google OAuth client secret;
- Google verification/audience configuration not intended for clients;
- Convex deploy key;
- Expo access token/push credentials where required;
- backup object-store credentials;
- export signing/encryption key;
- webhook signing secrets;
- Sentry auth token;
- optional email/SMS integration credentials.

### Rules

- no secret in Git, Markdown examples, mobile bundle, browser bundle, issue, screenshot, or analytics payload;
- secrets use environment-specific manager/provider storage;
- access is least privilege and attributed;
- rotation owner and procedure documented;
- production secret access logged where provider supports it;
- break-glass credentials are separate, time-limited, and reviewed after use;
- secret scan runs in CI and pre-commit guidance.

## 5. Google and Clerk setup

Per environment:

1. create Google Cloud project/credentials owned by organization;
2. configure OAuth consent screen and exact scopes;
3. create web client and platform clients required by Clerk Expo;
4. configure exact redirect URIs/package/bundle/signing fingerprints;
5. enable Google as the sole Clerk public connection;
6. activate Clerk–Convex integration and issuer;
7. configure session, account-linking, bot/abuse, and re-verification settings;
8. verify Clerk backend access to the Google OIDC ID token used for `hd`;
9. test `vitstudent.ac.in`, personal Gmail, wrong Workspace domain, expired intent, replay, and account linking;
10. coordinate managed VIT Workspace SSO separately if approved.

Production registration does not open until the VIT claim path passes on real controlled accounts.

## 6. Continuous integration

Pull request gates:

1. dependency lockfile and prohibited-secret check;
2. formatting;
3. lint;
4. TypeScript typecheck;
5. domain unit tests;
6. Convex function/auth/invariant tests;
7. web component tests;
8. reviewer component/storage tests;
9. Next.js production build;
10. Expo export/config validation;
11. Playwright critical-path smoke tests;
12. schema compatibility and generated API diff review;
13. accessibility checks;
14. package/license/security scan at agreed severity threshold.

Release candidates additionally run:

- staging deployment smoke;
- real-device Android/iOS reviewer flows;
- Google auth matrix;
- push ticket/receipt/acknowledgement flow;
- offline/reconnect/restart flow;
- migration dry run;
- rehearsal/load suite;
- export checksum/restore validation.

## 7. Release coordination

Because installed mobile builds can lag:

- backend changes are backward-compatible first;
- `commandSchemaVersion` and `supportedClientPolicy` are explicit;
- queries tolerate supported older shapes;
- new required fields are optional until adoption;
- incompatible mobile builds receive a blocking update screen before live review access;
- EAS runtime versions prevent incompatible over-the-air bundles;
- emergency web/backend rollback does not assume mobile rollback is instantaneous.

### Normal release

1. freeze release commit;
2. deploy compatible Convex schema/functions to staging;
3. deploy web staging;
4. publish preview mobile build/update;
5. execute acceptance suite;
6. approve release record;
7. deploy Convex production;
8. deploy web production;
9. publish/promote mobile production artifact/update;
10. run production smoke with test event/identities;
11. observe metrics and record completion.

### Event freeze

Before the live event:

- configuration revision frozen;
- production schema changes limited;
- mobile minimum version enforced;
- on-call owners assigned;
- rollback artifacts retained;
- rehearsal seed/test identities disabled from real views;
- change window and emergency approval policy active.

## 8. Observability

### Sentry

Capture:

- web/mobile crashes and handled exceptions;
- release/environment/runtime;
- route/screen and command/query name;
- performance spans for auth, initial subscription, mutation, reconnect, and scanner;
- breadcrumbs with redacted state transitions;
- source maps from CI.

Never capture:

- Google/Clerk tokens;
- full participant answers by default;
- score rationale/private notes;
- phone/registration number;
- QR tokens;
- push tokens;
- export contents.

### Convex operational telemetry

Application-owned tables/projections track:

- current event/round health;
- command counts/errors/latency classes;
- oldest outbox job;
- notification tickets/receipts/acks;
- active/stale leases;
- unsupported/revoked devices;
- queue/review transition durations;
- invariant/reconciliation exceptions;
- round-close blockers;
- audit pipeline sequence.

### Alerts

| Alert | Initial severity |
| --- | --- |
| Cannot authenticate broad user cohort | SEV-1/2 by scope |
| VIT verification false-positive suspicion | SEV-1 security |
| Review start/submit failure across panels | SEV-1 |
| Duplicate lease/invariant violation | SEV-1 |
| Notification paging impaired with in-app fallback | SEV-2 |
| One panel/device failure | SEV-3 |
| Outbox age above live threshold | SEV-2 |
| Audit write failure | SEV-1 |
| Unsupported app cohort before round | SEV-2 |

Every alert links impact, owner, and runbook.

## 9. Backups, exports, and recovery

### Layers

1. Convex provider backup/restore capability enabled and understood.
2. Scheduled application-level export of canonical outcome records to an independent object store.
3. Signed/checksummed round-boundary finalist/scoring snapshots.
4. Controlled offline/manual fallback forms only if approved.

Independent object storage may be Cloudflare R2, AWS S3, or another approved service. Final choice depends on organizational ownership, residency, and procurement; it does not alter live client architecture.

### Working objectives

- live-round RPO: ≤ 5 minutes for outcome-affecting application records;
- core-operation RTO: ≤ 30 minutes;
- round-boundary signed export before final decisions proceed;
- restore drill before launch using representative identity, queue, review, score, audit, and correction chains.

Provider capabilities must be tested against these objectives. If they cannot meet them, policy and fallback architecture are revised before launch.

### Export integrity

Each export records:

- event/config/rubric revision;
- generated-at and generator release;
- filters/record counts;
- ordered data files;
- SHA-256 checksums;
- signature/key version;
- requester and authorization;
- encrypted storage reference and retention;
- restore/validation result.

## 10. Data protection

- TLS in transit and provider encryption at rest;
- client-side encryption for reviewer local drafts;
- field/projection minimization;
- restricted audit/export access;
- encrypted sensitive profile fields where application-level protection is warranted;
- no durable personal data in QR/notifications;
- token and PII redaction in logs;
- environment data separation;
- retention jobs with approval and evidence;
- vendor data-processing/residency review before production.

Threat model covers OAuth/callbacks, role escalation, roster claim, QR replay, lost devices, local draft exposure, score confidentiality, privileged exports, push spoofing, outbox retry, and incident-mode abuse.

## 11. Performance and capacity rehearsal

Synthetic model includes:

- 1,000 participant portal subscriptions around round start;
- all reviewers authenticating/clocking in in a short interval;
- parallel QR token issue/scan bursts;
- concurrent queue changes and review starts;
- reviewer evidence/draft/submission traffic;
- operations users on command-centre projections;
- substitution push bursts;
- device disconnect/reconnect wave;
- Synesthesia vote burst;
- export/reconciliation after close.

Measure:

- function latency/error/conflict;
- subscription payload, invalidation, and propagation;
- client memory/battery/network;
- hot documents/indexes;
- notification processing;
- dashboard freshness;
- data correctness and invariant violations.

Load data is synthetic and notification targets are controlled.

## 12. Operational runbooks

Required before launch:

- Google/Clerk sign-in failure;
- VIT-domain verification failure;
- duplicate/merged account;
- reviewer invite/grant failure;
- unsupported mobile build/update;
- push failure/unacknowledged page;
- QR scan/manual presence fallback;
- Convex degradation/disconnection;
- stale/duplicate review lease;
- score receipt ambiguity;
- queue corruption/reconciliation;
- round close blocker;
- backup export/restore;
- lost reviewer device;
- secret compromise;
- sensitive export incident;
- degraded-mode activation and recovery.

Runbooks use named application commands. Direct production data edits are prohibited except a documented provider-level recovery supervised and audited by incident/security owners.

## 13. Ownership

| Area | Required owner |
| --- | --- |
| Google/Clerk configuration | Identity/security lead |
| Convex schema/functions | Backend lead |
| Web/Vercel | Web lead |
| Reviewer/EAS/push | Mobile lead |
| Rubric/configuration | Review product owner |
| Live dashboard/runbooks | Operations lead |
| Audit/retention/exports | Security/data owner |
| Incident command | Named event incident commander |

Personal developer accounts must not be the sole owner of production Google, Clerk, Convex, Vercel, Expo, Sentry, domain, signing, or backup resources.

## 14. Launch evidence

The release record must link:

- reviewed commit and lockfile;
- production deployment/build/update IDs;
- active schema/config/rubric revisions;
- Google/Clerk auth matrix result;
- permission test result;
- load/realtime result;
- device/push result;
- backup/restore result;
- accessibility result;
- open risk acceptance;
- on-call roster;
- go/no-go decision.

## 15. Official references

- [Next.js App Router](https://nextjs.org/docs/app)
- [Convex realtime](https://docs.convex.dev/realtime)
- [Convex and Clerk](https://docs.convex.dev/auth/clerk)
- [Clerk Expo quickstart](https://clerk.com/docs/expo/getting-started/quickstart)
- [Expo push notification overview](https://docs.expo.dev/push-notifications/overview/)
- [Expo notification delivery behavior](https://docs.expo.dev/push-notifications/what-you-need-to-know/)
- [Expo Push Service tickets and receipts](https://docs.expo.dev/push-notifications/sending-notifications/)
- [EAS Update channels](https://docs.expo.dev/eas-update/getting-started/)

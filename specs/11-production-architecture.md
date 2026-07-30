# Production architecture

## 1. Selected stack

| Layer | Technology |
| --- | --- |
| Language | TypeScript |
| Workspace | pnpm workspaces |
| Participant/staff web | Next.js App Router and React |
| Reviewer mobile | Expo, React Native, Expo Router |
| Authentication | Better Auth, Google provider only |
| Better Auth database/host | Convex component via `@convex-dev/better-auth` |
| Application backend | Convex database, queries, mutations, actions, HTTP actions, scheduler, and file storage |
| Live client updates | Convex reactive queries |
| Provider job control | `@convex-dev/workpool` with separate bounded GitHub, Figma, push, and export pools |
| Provider integrations | GitHub App installation tokens/webhooks and Figma OAuth/Webhooks V2 |
| Mobile camera | `expo-camera` |
| Mobile notifications | `expo-notifications` and Expo Push Service |
| Mobile protected storage | `expo-secure-store`; SQLCipher-backed `expo-sqlite` for one active draft |
| Web hosting | Vercel |
| Mobile build/release | EAS Build and EAS Update |
| Crash reporting | Sentry for web and mobile |
| Large artifacts and recovery copy | Private AWS S3 bucket in `ap-south-1`, versioned and encrypted with KMS, subject to VIT data-policy approval |
| CI | GitHub Actions |
| Tests | Vitest, Convex function tests, Playwright, Maestro, and a Convex load driver |

Dependency versions are locked in the repository and upgraded only after staging auth, push, camera, and review tests pass.

## 2. Why this shape

The event needs two client platforms and one shared live state.

- Next.js covers participant and staff web routes.
- Expo provides the native reviewer features requested in the planning discussion.
- Better Auth runs on Convex, so authentication does not add a hosted auth vendor or second auth database.
- Convex supplies transactions and reactive queries; a custom REST database and WebSocket service would repeat those jobs.
- Workpool bounds provider concurrency and retries. A Figma outage or a burst of GitHub pushes cannot consume every scheduled-job slot.
- Convex stores small live projections. Compressed Figma files, captured previews, round exports, and downloaded backups belong in private object storage rather than one-megabyte Convex documents.
- Expo Push attracts reviewer attention. The assignment still lives in Convex.
- pnpm workspaces are enough for two applications and one shared package. A build-orchestration framework can be added if measured CI time later warrants it.

## 3. System map

```text
Google OAuth
    |
    v
Better Auth routes on Convex
    |                         GitHub signed webhooks
    |                         Figma OAuth / passcode webhooks
    v                              |
Next.js web <----------> Convex <--> bounded provider Workpools
    ^                     ^
    |                     |
    +---- participant     +---- Expo reviewer app
          operations           camera / SecureStore / local active draft

Convex scheduled action --> Expo Push Service --> reviewer device
Integration artifacts --> private S3 artifact bucket
Round exports/backups --> private S3 recovery prefixes
```

The participant portal, operations dashboard, and reviewer app do not copy live event records into separate databases.

## 4. Repository

```text
apps/
  web/                    Next.js participant and staff routes
  reviewer/               Expo reviewer application
convex/
  betterAuth/             Better Auth component, schema, and adapter
  auth.config.ts          Convex auth provider configuration
  http.ts                 Auth routes and signed webhook endpoints
  schema.ts               Application tables and indexes
  identity/               participant provisioning and roster claim
  teams/                  teams, projects, check-in, ready
  admissions/             application review, decisions, offers, capacity
  reviews/                panels, queues, presence, sessions, scorecards
  integrations/           team bindings, GitHub/Figma webhooks, snapshots, metrics
  workpools/              bounded provider, push, and export work
  operations/             protected floor commands and projections
  synesthesia/            request, vote, moderation, playback
  lib/                    capability, state, audit, and operation helpers
packages/
  domain/                 pure rubric, routing, queue, and state-transition rules
```

Convex-generated API and data-model types remain in `convex/_generated`. The shared domain package contains pure functions and configuration types, not a hand-written copy of the database schema.

Web and mobile UI packages remain separate until real duplication appears. Sharing a small domain package is cheaper than forcing DOM and React Native components into one abstraction.

## 5. Better Auth on Convex

Install:

- `better-auth`
- `@convex-dev/better-auth`
- `@better-auth/expo`

The Convex-maintained Better Auth adapter stores auth users, provider accounts, sessions, and verification data in a Convex component.

Configuration:

- Google is the only social provider.
- Email/password is disabled.
- Auth routes are registered in `convex/http.ts`.
- Next.js proxies `/api/auth/[...all]` to the Convex auth handler.
- The Expo client calls the same auth base URL and returns through environment-specific deep links.
- Production trusts only the production web origin and app scheme. Development wildcard schemes never enter production configuration.
- Web, iOS, and Android Google client IDs are configured as required by the final sign-in method.
- `BETTER_AUTH_SECRET` and Google client secrets live in Convex environment variables.

The application creates a `person` record after auth. It links the Better Auth user ID and the verified Google provider subject. Event roles and participant class stay in application tables.

## 6. Participant auth request

1. Next.js calls a Convex mutation to create a short-lived auth intent for VIT or External.
2. Better Auth starts Google OAuth and preserves the intent nonce in validated OAuth state.
3. Google returns to the Better Auth callback on Convex.
4. Better Auth validates the provider response and creates/resumes the session.
5. The callback/provisioning hook records the verified Google `sub`, email, and `hd` needed by the application.
6. `identity.provisionParticipant` consumes the intent, derives participant class, and creates/resumes event membership in one mutation.
7. The web client subscribes to `viewer.bootstrap` and routes to the first unfinished participant task.

The auth spike in Delivery and acceptance must prove step 5 on both web and Expo before registration work continues.

## 7. Reviewer/staff auth request

1. User opens the staff web route or reviewer app.
2. Better Auth completes Google sign-in.
3. `identity.claimRoster` matches an unclaimed row by verified email for the first claim.
4. The mutation links that row to the Better Auth user and Google subject, then creates the time-bound event grant.
5. Later requests resolve current grants from the linked person ID.

Next.js route guards and Expo navigation can hide inaccessible screens. Convex still checks the grant inside every protected query and write.

## 8. Reads

Clients subscribe to purpose-built queries such as:

- `viewer.bootstrap`
- `participant.home`
- `admissions.reviewQueue`
- `admissions.capacity`
- `participant.queueStatus`
- `reviewer.now`
- `reviewer.activeContext`
- `operations.roundBoard`
- `operations.panelDetail`
- `operations.scoreCompleteness`

Each query:

- resolves the current person;
- checks the required event capability;
- uses declared indexes;
- returns only fields needed by that screen;
- avoids secret tokens and unrelated personal data.

Next.js may preload an authenticated query for the first render using the Better Auth/Convex server helpers. Live screens continue through the Convex React client.

Do not expose generic “read any table” functions.

## 9. Writes

Convex mutations handle state changes. A protected mutation:

1. validates input;
2. resolves identity and active grant;
3. loads the current records through indexes;
4. checks conflict, scope, state, and expected version;
5. resolves a repeated operation ID when the command is high-impact;
6. writes the domain change;
7. writes a narrow audit event when required;
8. schedules external work after the transaction when required;
9. returns the accepted ID, version, and server time.

Do not perform GitHub, Figma, Expo, Sentry, or S3 network calls inside the database transaction.

Low-risk draft saves can use a compact operation ID and expected version. A score submission, page acceptance, review start, move, correction, or round change must resolve an ambiguous response before the client sends a new command.

## 10. External I/O

Convex HTTP actions receive:

- Better Auth routes;
- GitHub App setup callback;
- GitHub signed webhooks;
- Figma OAuth callback.

Convex actions call:

- GitHub repository, topic, commit, compare, tree, contents, language, and installation APIs;
- Figma metadata, full file, version, comment, image, OAuth-token, and webhook APIs;
- Expo Push Service;
- S3 integration-artifact and export upload.

A mutation writes a pending job record and enqueues an internal action in the relevant Workpool. The action performs the network call, then records success, provider-directed delay, retry, or terminal failure through an internal mutation.

Retries use provider delivery IDs or an application deduplication key. Pools have explicit parallelism, exponential backoff with jitter, and a completion handler. A GitHub rate reset or Figma `Retry-After` overrides ordinary retry timing. Jobs have a maximum attempt count and appear on the operations/integration diagnostics screen.

## 11. Live updates

Convex reactive queries keep affected screens current after a committed write.

Examples:

- `teams.setReady` changes participant home, routing work, and the operations ready list.
- `admissions.publishDecision` changes participant admission state and confirmed-capacity views.
- `pages.accept` changes reviewer Now, panel staffing, and the operations exception list.
- `reviews.start` changes participant state, reviewer context, panel row, queue, and active-review board.
- `scorecards.submit` changes the reviewer receipt and operations completeness; it does not reveal the value to other reviewers.
- A verified GitHub push changes the team activity card before its slower enrichment job completes.
- A Figma metadata version change marks content dirty, then a completed snapshot replaces the derived design view.

Large boards subscribe to indexed summaries and paginated detail. They do not subscribe to every raw event record and filter it in the browser.

Provider delivery and application realtime are separate. Convex updates clients after a committed event; GitHub usually sends pushes quickly, while Figma `FILE_UPDATE` may wait for editing inactivity. Every integration view shows the age of its metadata and full snapshot.

## 12. Mobile local state

The reviewer app uses:

- Better Auth session cookie in SecureStore;
- Convex client cache for current reactive data;
- one SQLCipher database for the active review context, score draft, and pending operations;
- ordinary component state for screen interaction.

No Redux store mirrors the backend. When the active review finishes and all operations are confirmed, the app deletes its local context and draft after the configured short recovery window.

## 13. Files

Convex file storage contains:

- scanned manual-review sheets;
- optional participant eligibility evidence if policy requires it;
- generated round-export manifests before off-site copy.

Access uses authorised functions. A Convex storage ID is never treated as permission, and a generated Convex file URL is a bearer URL rather than an expiring authorization token. Protected small files are served through an HTTP action after a capability check; artifacts that require expiring signed access use private S3.

Full Figma JSON and captured previews go to private S3 because they can exceed Convex document/HTTP-response limits and need expiring signed access. GitHub source is fetched at a pinned SHA when an assigned reviewer opens a file; only a short-lived encrypted blob cache may be stored. Convex keeps manifests, checksums, hashes, and derived metrics.

## 14. Deployment

### Web

Vercel deploys `apps/web`. Preview deployments use development/staging data only. Production custom domains and auth callback URLs are fixed before auth sign-off.

### Backend

Convex has separate development, staging, and production deployments. Production deploys run schema and function tests first. A function change must remain compatible with the current production reviewer build or raise the configured minimum build after devices are updated.

### Mobile

EAS uses separate staging and production profiles, schemes, Google client settings, and update channels. Native dependency/configuration changes require a signed build. EAS Update is used only for JavaScript changes compatible with the installed runtime.

## 15. Secrets

| Store | Secrets |
| --- | --- |
| Convex environment | Better Auth secret, Google secret, GitHub App private key/webhook secret, Figma client secret, token-encryption key, Expo server credential, S3 restricted credential |
| Vercel environment | Public Convex URLs, public site URL, Sentry DSN; no provider private key |
| EAS secrets/config | Public backend/auth URLs, app scheme/client IDs, Sentry DSN, build credentials |
| GitHub Actions | Vercel/Convex/EAS deploy credentials scoped by environment |

Figma OAuth grants are encrypted once per Figma App/user and referenced by team-owned file bindings. Figma webhook passcodes are random and stored encrypted or as verification hashes. GitHub installation tokens are minted when needed and not persisted after expiry.

## 16. Security boundaries

- Google proves identity; application records grant event access.
- Better Auth sessions prove the caller; Convex functions still check the current role.
- Client-supplied event, team, reviewer, score, and role IDs are always checked against the caller.
- Provider callbacks use exact allowlisted URLs and validated state.
- GitHub webhook signatures are verified against the raw body before JSON parsing affects state.
- Figma webhook passcodes, webhook IDs, file keys, event timestamps, and deduplication keys are checked before a provider event changes state.
- Logs redact cookies, authorization headers, provider tokens, participant phone numbers, and private notes.
- Artifact/export credentials can write only to the event’s bucket prefixes.
- Production support never edits Convex tables from the dashboard console as a normal operating method; protected maintenance functions record changes.

## 17. Observability

- Sentry receives web/mobile exceptions, release ID, environment, route/screen, and non-sensitive event identifiers.
- Convex logs function errors, external-job attempts, and scheduled-work failures.
- Integration diagnostics show Workpool backlog, provider rate-limit windows, webhook age, metadata age, full-snapshot age, and incomplete/truncated results.
- The operations dashboard shows business failures such as missing presence, unacknowledged page, stale draft, and round blocker.
- GitHub Actions records build/test/deploy results.

Business history stays in domain records and audit events. Sentry is not the judging ledger.

## 18. Architecture acceptance

- Google sign-in works on Next.js and a signed Expo build through the same Better Auth instance.
- No Clerk package, environment, issuer, or user ID appears in the product repository.
- An auth session alone cannot read event data without an active application grant.
- Web and mobile see one accepted test mutation live.
- A stale or duplicate high-impact write cannot create a second review, assignment, or scorecard.
- External provider failure cannot hold open a Convex transaction.
- A burst of provider events stays inside configured Workpool concurrency and does not starve review writes.
- Team integration access follows the team binding even when the Figma authorizer changes.
- Production secrets do not appear in web/mobile bundles, logs, source control, or push payloads.
- Current production mobile builds remain compatible through a backend deploy and rollback rehearsal.

## References

- [Better Auth Convex integration](https://better-auth.com/docs/integrations/convex)
- [Better Auth Expo integration](https://better-auth.com/docs/integrations/expo)
- [Convex realtime queries](https://docs.convex.dev/realtime)
- [Convex transactions and optimistic concurrency](https://docs.convex.dev/database/advanced/occ)
- [Convex scheduling and durable function components](https://docs.convex.dev/scheduling/overview)
- [Convex limits](https://docs.convex.dev/production/state/limits)
- [Convex Workpool](https://github.com/get-convex/workpool)
- [Expo push notification overview](https://docs.expo.dev/push-notifications/overview/)

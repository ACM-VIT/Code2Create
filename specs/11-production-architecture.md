# Production architecture

## 1. Selected stack

| Layer | Technology |
| --- | --- |
| Language | TypeScript |
| Workspace | pnpm workspaces |
| Participant/staff web | Next.js App Router and React |
| Reviewer/attendance mobile | Expo, React Native, Expo Router |
| Authentication | Better Auth, Google provider only |
| Better Auth database/host | Convex component via `@convex-dev/better-auth` |
| Application backend | Convex database, queries, mutations, actions, HTTP actions, scheduler, and file storage |
| Live client updates | Convex reactive queries |
| Project-intake interpretation | OpenAI Responses API with strict Structured Outputs, called only from a Convex action |
| External job control | `@convex-dev/workpool` with separate bounded intake, GitHub, Figma, push, and export pools |
| Provider integrations | GitHub App installation tokens/webhooks and Figma OAuth/Webhooks V2 |
| Mobile camera | `expo-camera` |
| Mobile NFC | `react-native-nfc-manager` behind an app-local adapter in custom EAS builds; real VIT ID card profiles are qualified on provisioned Android devices before use |
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
- Workpool bounds external concurrency and retries. Model or provider trouble cannot consume every scheduled-job slot.
- Convex stores small live projections. Compressed Figma files, captured previews, round exports, and downloaded backups belong in private object storage rather than one-megabyte Convex documents.
- Expo Push attracts reviewer attention. The assignment still lives in Convex.
- pnpm workspaces are enough for two applications and one shared package. A build-orchestration framework can be added if measured CI time later warrants it.

## 3. System map

```text
Google OAuth
    |
    v
Better Auth routes on Convex
    |                         OpenAI Responses API
    |                         GitHub signed webhooks
    |                         Figma OAuth / passcode webhooks
    v                              |
Next.js web <----------> Convex <--> bounded external Workpools
    ^                     ^
    |                     |
    +---- participant     +---- Expo event app
          operations           camera / NFC / SecureStore / bounded local recovery

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
  attendance/             plans, sessions, credentials, stations, scan ledger, presence projections
  intake/                 versioned shell, question policy, track catalog, generated prompts, project brief
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
- `participant.attendance`
- `admissions.reviewQueue`
- `admissions.capacity`
- `participant.queueStatus`
- `reviewer.now`
- `reviewer.activeContext`
- `operations.roundBoard`
- `attendance.scannerNow`
- `operations.attendanceBoard`
- `operations.emergencyRollCall`
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

Attendance scans use the same mutation discipline at higher write volume. `attendance.recordScan` validates the operator, registered device, station configuration, credential version, session, expectation, direction, and anti-passback state. One transaction records the attempt, opens/closes an interval when accepted, updates the individual projection, and moves the participant between counter shards. It does not call an external service.

Attendance cohort creation and session close are not thousand-record mutations. `attendance.prepareSession` and `attendance.closeSession` create resumable internal jobs processed in indexed scheduled batches. Opening requires a complete expectation checksum. Closing fixes the cutoff/version, exposes `closing`, and reaches `closed` only after participant results and counters verify. These jobs do not use an external Workpool slot.

## 10. External I/O

Convex HTTP actions receive:

- Better Auth routes;
- GitHub App setup callback;
- GitHub signed webhooks;
- Figma OAuth callback.

Convex actions call:

- OpenAI Responses API for bounded intake interpretation;
- GitHub repository, topic, commit, compare, tree, contents, language, and installation APIs;
- Figma metadata, full file, version, comment, image, OAuth-token, and webhook APIs;
- Expo Push Service;
- S3 integration-artifact and export upload.

A mutation writes a pending job record and enqueues an internal action in the relevant Workpool. The action performs the network call, then records success, provider-directed delay, retry, or terminal failure through an internal mutation.

Retries use provider delivery IDs or an application deduplication key. Pools have explicit parallelism, exponential backoff with jitter, and a completion handler. A GitHub rate reset or Figma `Retry-After` overrides ordinary retry timing. Jobs have a maximum attempt count and appear on the operations/integration diagnostics screen.

## 11. OpenAI intake interpretation

The model is a stateless interpreter behind the participant screen. It is not a conversation store or an application authority.

The write path is:

1. `intake.saveAnswer` commits the participant’s verbatim answer version and advances the deterministic session version.
2. The mutation creates a pending `intakeInterpretation` keyed by the answer-set hash, intake-flow version, track-catalog version, and model-config version.
3. The bounded `intake_ai` Workpool calls `POST /v1/responses` from a Convex action.
4. The request uses `store: false`, no tools, no web access, and strict JSON Schema through `text.format`.
5. An internal mutation validates every returned key plus the generated question's purpose, length, single-question form, wording policy, source IDs, freshness, and ordinal against the pinned configuration.
6. If still current, the mutation stores the question as an immutable `intakeGeneratedQuestion` and advances the session. Otherwise the route query serves the phase's published deterministic fallback. The participant separately accepts the freshness attestation and confirms track selections and final brief fields.

The schema returns source-linked brief fields, candidate track keys, purpose coverage, an optional generated `nextQuestion { text, purposeKey, answerLength, sourceAnswerVersionIds }`, and `stopReason`. Structured Outputs constrains the shape and closed enums; question text remains model-generated and requires application validation. Unknown IDs, unavailable tracks, stale sources, oversized/compound/repeated/prohibited questions, a question beyond the fifth ordinal, refusal, incomplete response, or a mismatched schema version make that next question unusable.

Every `intakeModelConfigVersion` freezes:

- the approved model ID or snapshot;
- system-instruction, input-redaction, question-policy, and JSON-Schema checksums;
- allowed output enums derived from the paired published phase/track versions;
- phase-specific generated-question bounds, including three to five for the introduction, plus the 140-character limit, allowed purpose keys, blocked patterns, and fallback mapping;
- input/output character and token limits;
- soft latency deadline, hard timeout, retry count, and Workpool priority;
- `store: false` and the no-tools contract;
- evaluation-suite version and publication actor.

A new model, instruction, or question policy is evaluated on staged synthetic/adversarial answers before publication. The suite measures relevance, ease of answering, duplication, compound questions, prohibited/PII topics, source attribution, track fit, length, and fallback rate. Human reviewers inspect representative generated paths. Active sessions remain pinned to their starting configuration unless an explicit migration maps every answer, generated question, fallback, and phase and reports the effect.

The participant never waits indefinitely for interpretation. When the soft deadline passes, the server returns the deterministic fallback edge. Late output may help a later unanswered step, but it cannot replace the question currently visible. A refusal, invalid schema, timeout, quota error, or OpenAI outage leaves the raw answer intact and the complete fallback intake usable.

Only redacted project-intake text, source answer IDs, and published definitions are sent. Application-owned identifiers, contact details, auth data, admission state, provider credentials, reviewer material, and scores are excluded. A versioned deterministic preprocessor replaces common contact, registration-number, credential, and secret patterns inside free text; because free text cannot be guaranteed anonymous, the participant policy still discloses the processing and asks teams not to enter unnecessary personal data. API data is not used for model training, but `store: false` is not described to participants as zero retention: ordinary API abuse-monitoring logs can retain customer content for up to 30 days unless the organisation is approved and configured for Modified Abuse Monitoring or Zero Data Retention. The published consent/retention policy must state the effective account controls.

## 12. Live updates

Convex reactive queries keep affected screens current after a committed write.

Examples:

- `teams.setReady` changes participant home, routing work, and the operations ready list.
- `admissions.publishDecision` changes participant admission state and confirmed-capacity views.
- `pages.accept` changes reviewer Now, panel staffing, and the operations exception list.
- `reviews.start` changes participant state, reviewer context, panel row, queue, and active-review board.
- `scorecards.submit` changes the reviewer receipt and operations completeness; it does not reveal the value to other reviewers.
- `attendance.recordScan` changes the participant status, scanner receipt, session/zone counts, team availability, and an active roll call. The raw scan ledger is not a dashboard subscription.
- `attendance.closeSession` changes the session to closing immediately; small scheduled batches then publish final per-participant results and a verified closed state without blocking scans or reviews elsewhere.
- A verified GitHub push changes that repository row and the team rollup before its slower enrichment job completes.
- A Figma metadata version change marks content dirty, then a completed snapshot replaces the derived design view.

Large boards subscribe to indexed summaries and paginated detail. They do not subscribe to every raw event record and filter it in the browser.

Provider delivery and application realtime are separate. Convex updates clients after a committed event; GitHub usually sends pushes quickly, while Figma `FILE_UPDATE` may wait for editing inactivity. Every integration view shows the age of its metadata and full snapshot.

## 13. Mobile local state

The reviewer app uses:

- Better Auth session cookie in SecureStore;
- Convex client cache for current reactive data;
- one SQLCipher database for the active review context, score draft, and pending operations;
- ordinary component state for screen interaction.

Attendance scanner mode additionally keeps one encrypted, size- and age-bounded pending operation queue containing opaque credential payload, station/configuration version, device sequence, capture time, and operation ID. It displays these records as pending until the server resolves them. Accepted replay removes them; rejected or contradictory replay remains visible for operator review. The queue contains no participant directory and is not used to calculate local attendance totals.

No Redux store mirrors the backend. When the active review finishes and all operations are confirmed, the app deletes its local context and draft after the configured short recovery window.

## 14. Files

Convex file storage contains:

- scanned manual-review sheets;
- optional participant eligibility evidence if policy requires it;
- generated round-export manifests before off-site copy.

Access uses authorised functions. A Convex storage ID is never treated as permission, and a generated Convex file URL is a bearer URL rather than an expiring authorization token. Protected small files are served through an HTTP action after a capability check; artifacts that require expiring signed access use private S3.

Full Figma JSON and captured previews go to private S3 because they can exceed Convex document/HTTP-response limits and need expiring signed access. GitHub source is fetched from the selected repository at its pinned SHA when an assigned reviewer opens a file; only a short-lived encrypted blob cache may be stored. Convex keeps repository/checkpoint-set manifests, checksums, hashes, and derived metrics.

## 15. Deployment

### Web

Vercel deploys `apps/web`. Preview deployments use development/staging data only. Production custom domains and auth callback URLs are fixed before auth sign-off.

### Backend

Convex has separate development, staging, and production deployments. Production deploys run schema and function tests first. A function change must remain compatible with the current production reviewer build or raise the configured minimum build after devices are updated.

### Mobile

EAS uses separate staging and production profiles, schemes, Google client settings, NFC/camera configuration, and update channels. Native dependency/configuration changes require a signed build. EAS Update is used only for JavaScript changes compatible with the installed runtime. The scanner fleet records whether each installation passed the representative VIT-card profiles, camera, repeated-scan, background/resume, and offline-replay rehearsal.

## 16. Secrets

| Store | Secrets |
| --- | --- |
| Convex environment | Better Auth secret, Google secret, OpenAI API key, GitHub App private key/webhook secret, Figma client secret, token-encryption key, attendance-key wrapping key, Expo server credential, S3 restricted credential |
| Vercel environment | Public Convex URLs, public site URL, Sentry DSN; no provider private key |
| EAS secrets/config | Public backend/auth URLs, app scheme/client IDs, Sentry DSN, build credentials |
| GitHub Actions | Vercel/Convex/EAS deploy credentials scoped by environment |

Figma OAuth grants are encrypted once per Figma App/user and referenced by team-owned file bindings. Figma webhook passcodes are random and stored encrypted or as verification hashes. GitHub installation tokens are minted when needed and not persisted after expiry.

## 17. Security boundaries

- Google proves identity; application records grant event access.
- Better Auth sessions prove the caller; Convex functions still check the current role, duty, and scope.
- Client-supplied event, team, judge, score, role, and duty IDs are always checked against the caller.
- A phone-read VIT card identifier is sent only to the authorised attendance command, converted into an event-scoped keyed fingerprint, and discarded. Raw identifiers never become account identity, records, logs, or exports.
- External-badge QR bearers contain no identity and are stored only as hashes. Short-lived portal QR tokens resolve the already-authenticated event member.
- Station mode, direction, zone, and attendance session are server-owned configuration. A card, badge, or participant cannot select the transition.
- Provider callbacks use exact allowlisted URLs and validated state.
- Participant answers are untrusted model input; the OpenAI request has no tools, credentials, score data, or write capability.
- GitHub webhook signatures are verified against the raw body before JSON parsing affects state.
- Figma webhook passcodes, webhook IDs, file keys, event timestamps, and deduplication keys are checked before a provider event changes state.
- Logs redact cookies, authorization headers, provider tokens, participant phone numbers, and private notes.
- Artifact/export credentials can write only to the event’s bucket prefixes.
- Production support never edits Convex tables from the dashboard console as a normal operating method; protected maintenance functions record changes.

## 18. Observability

- Sentry receives web/mobile exceptions, release ID, environment, route/screen, and non-sensitive event identifiers.
- Convex logs function errors, external-job attempts, and scheduled-work failures.
- Intake diagnostics show model latency, timeout/refusal/schema-failure/question-policy-rejection/fallback rates, token usage, skips by purpose or fallback key, and config version without logging answer or generated-question text.
- Integration diagnostics show Workpool backlog, provider rate-limit windows, webhook age, metadata age, full-snapshot age, and incomplete/truncated results.
- Attendance diagnostics show scan latency/outcome, station heartbeat, pending replay age, credential anomalies, projection/counter consistency, and zone/session exception counts without logging bearer values.
- The operations dashboard shows business failures such as missing presence, unacknowledged page, stale draft, and round blocker.
- GitHub Actions records build/test/deploy results.

Business history stays in domain records and audit events. Sentry is not the judging ledger.

## 19. Architecture acceptance

- Google sign-in works on Next.js and a signed Expo build through the same Better Auth instance.
- No Clerk package, environment, issuer, or user ID appears in the product repository.
- An auth session alone cannot read event data without an active application grant.
- Web and mobile see one accepted test mutation live.
- An enrolled VIT ID card, external-badge QR, and dynamic portal QR reach one attendance command and produce the same participant-scoped transition.
- A scan updates participant, scanner, operations, team-availability, zone, and roll-call views without scanning the raw event ledger.
- Simultaneous credential methods, offline replay, VIT card rebinding, external-badge replacement, and session close cannot create duplicate intervals or silently overwrite a newer presence state.
- Overlapping optional/cohort sessions keep separate attendance rows, and large-cohort expectation/finalisation work is resumable after function failure.
- A stale or duplicate high-impact write cannot create a second review, assignment, or scorecard.
- External provider failure cannot hold open a Convex transaction.
- An answer is durable before model work begins; OpenAI failure follows the configured fallback path and cannot block submission.
- A successful introduction contains three to five generated follow-ups; each is short, single-purpose, immutable, and tied to the source/configuration versions that produced it.
- Model output cannot call a mutation, select a phase or track, accept the freshness attestation, change a participant answer, publish a brief, or reach judging data.
- Every generated brief field names its source answer versions and the exact intake, track, schema, and model-config versions.
- A burst of provider events stays inside configured Workpool concurrency and does not starve review writes.
- One team can add repositories from several GitHub App installations, classify and reorder them, and freeze all of them in one review checkpoint set.
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
- [OpenAI Responses API](https://developers.openai.com/api/reference/resources/responses)
- [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [OpenAI evaluation best practices](https://developers.openai.com/api/docs/guides/evaluation-best-practices)
- [OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data)
- [Expo push notification overview](https://docs.expo.dev/push-notifications/overview/)
- [Expo development builds](https://docs.expo.dev/develop/development-builds/introduction/)
- [Expo custom native code](https://docs.expo.dev/workflow/customizing/)
- [React Native NFC Manager](https://github.com/revtel/react-native-nfc-manager)
- [Android NFC overview](https://developer.android.com/develop/connectivity/nfc)
- [Apple Core NFC](https://developer.apple.com/documentation/CoreNFC)

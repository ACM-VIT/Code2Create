# Production architecture

## 1. Selected stack

| Layer                                 | Technology                                                                                                                                                                                                                                                       |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Language                              | TypeScript                                                                                                                                                                                                                                                       |
| Workspace                             | pnpm workspaces                                                                                                                                                                                                                                                  |
| Participant and operations web        | Separate Vite, React, and React Router SPAs                                                                                                                                                                                                                      |
| Reviewer/event-operations mobile      | Expo, React Native, Expo Router                                                                                                                                                                                                                                  |
| Authentication                        | Better Auth, Google provider only                                                                                                                                                                                                                                |
| Better Auth database/host             | Convex component via `@convex-dev/better-auth`                                                                                                                                                                                                                   |
| Application backend                   | Convex database, queries, mutations, actions, HTTP actions, scheduler, and file storage                                                                                                                                                                          |
| Live client updates                   | Convex reactive queries                                                                                                                                                                                                                                          |
| Live novelty signal                   | OpenAI `text-embedding-3-small` at its native 1,536 dimensions plus a corpus-filtered Convex vector index; one atomic response per debounced preview                                                                                                             |
| Project-intake interpretation         | OpenAI Responses API with strict Structured Outputs, called only from a Convex action                                                                                                                                                                            |
| Admission analysis                    | A separate OpenAI Structured Outputs contract, configuration, and bounded Convex action; human decisions remain authoritative                                                                                                                                    |
| Durable intelligence                  | Flue on a separate Vite-built Cloudflare Worker, OpenAI Responses, and one Durable Object agent instance per job identity; Convex remains authoritative                                                                                                          |
| External job control                  | Native scheduled actions with a 20-second server fallback for participant intake; `@convex-dev/workpool` for admission analysis (16 slots), intelligence dispatch, integrations, and exports; short participant-email sends use claimed Convex scheduler actions |
| Provider integrations                 | GitHub App installation tokens/webhooks and Figma OAuth/Webhooks V2                                                                                                                                                                                              |
| Participant status email              | Cloudflare Email Sending REST API, lifecycle Event Subscription to Queues, a small HMAC bridge Worker, and Cloudflare Email Routing for the approved inbound support alias; generic text links back to authenticated portal state                                |
| Mobile camera                         | `expo-camera` for VIT ID barcodes, static external event passes, external physical-ID barcodes, optional external badges, and review-presence QR; explicit app modes keep each purpose on its own permission and server command                                      |
| Mobile notifications                  | Native tokens through `expo-notifications`; direct Firebase Cloud Messaging and Apple Push Notification service sends                                                                                                                                            |
| Outbound calls                        | Reusable event-owned voice service with synthesized scripts, push-first escalation, consent, scoped permissions, provider callbacks, and audit                                                                                                                   |
| Mobile protected storage              | `expo-secure-store`; SQLCipher-backed `expo-sqlite` for one active draft                                                                                                                                                                                         |
| Web hosting                           | Cloudflare Workers static assets through `@cloudflare/vite-plugin`                                                                                                                                                                                               |
| Mobile build/release                  | Local Expo prebuild plus signed Gradle/Xcode artifacts; event-owned Expo Updates Worker and private R2 buckets                                                                                                                                                   |
| Product analytics and crash reporting | PostHog for privacy-filtered web/mobile page and screen events, exception capture, and release symbolication                                                                                                                                                     |
| Large artifacts and recovery copy     | Private AWS S3 bucket in `ap-south-1`, versioned and encrypted with KMS, for evidence, protected exports, expiring emergency packs, and recovery copies, subject to VIT data-policy approval                                                                     |
| Verification and Worker delivery      | GitHub Actions for checks; Cloudflare Workers Builds for branch-bound Worker deployment                                                                                                                                                                          |
| Tests                                 | Vitest, Convex function tests, Playwright, and Maestro                                                                                                                                                                                                           |

The repository locks all dependency versions. The team upgrades them only after staging tests pass for authentication, push, camera, and reviews.

## 2. Why this shape

The event needs two client platforms and one shared live state.

- Separate Vite SPAs keep participant and operations delivery separate. All authoritative product reads and writes remain in Convex.
- Expo provides the native reviewer features requested in the planning discussion.
- Better Auth runs on Convex, so authentication does not add a hosted auth vendor or second auth database.
- Convex supplies transactions and reactive queries. A custom REST database and WebSocket service would repeat these functions.
- Workpool limits heavy external jobs and their retries. Participant email uses a small persistent delivery state machine and short claim lease. It retries only after explicit provider non-acceptance. One email API request does not need a pool abstraction.
- Convex stores small live projections. Compressed Figma files, captured previews, protected exports, expiring emergency packs, and downloaded backups belong in private object storage rather than one-megabyte Convex documents.
- Backup and restore run from a separate operator environment. Production export, staging import, and recovery S3 use different credentials. A browser, mobile client, or Convex function cannot start a destructive restore.
- APNs and FCM alert a reviewer first. The event-owned voice service can place a consented synthesized call after the configured delay. The page remains in Convex. Provider acceptance is not reviewer acknowledgment.
- The update Worker stores no event state. It serves signed release metadata and immutable assets while Convex remains the application backend.
- Flue gives a separate Cloudflare Worker durable state for each job. It receives a frozen projection and returns a signed result. It is not an event backend or authorization service.
- pnpm workspaces support the eight apps and three focused shared packages. Add a build-orchestration framework only if measured CI time requires it.

## 3. System map

```text
Google OAuth
    |
    v
Better Auth routes on Convex
    |                         OpenAI Responses + Embeddings APIs
    |                         GitHub signed webhooks
    |                         Figma OAuth / passcode webhooks
    v                              |
Cloudflare-hosted Vite SPAs <----> Convex <--> bounded external Workpools
    ^                              ^
    |                              |
    +---- participant              +---- Expo event app
          operations                    camera / SecureStore / bounded local recovery
                                            |
Cloudflare update Worker <--> private R2 ---+

Convex -- signed frozen projection --> Flue intelligence Worker
Convex <-- signed validated callback -- Flue intelligence Worker
Flue intelligence Worker --> OpenAI Responses API

Convex scheduled action --> APNs / FCM --> reviewer device
Convex scheduled action --> voice Worker/provider --> reviewer phone
Convex scheduled action --> Cloudflare Email Sending --> participant verified email
Cloudflare Email Event Subscription --> Queue --> email Worker --> signed Convex delivery event
Inbound support alias --> Cloudflare Email Routing --> email Worker --> verified operations mailbox
Integration artifacts --> private S3 artifact bucket
Emergency/round/attendance exports --> private S3 export prefixes
Backups --> private S3 recovery prefixes
Recovery operator CLI --> production export / staging-only import and re-export
```

The participant portal, operations dashboard, and reviewer app do not copy live event records into separate databases.

## 4. Repository

```text
apps/
  web/                    Vite participant portal
  ops/                    Vite permission-gated operations dashboard
  reviewer/               Expo reviewer application
  updates/                Expo Updates protocol Worker and local signed publisher
  intelligence/           Flue/Vite Cloudflare Worker for bounded durable intelligence jobs
  email/                  Cloudflare Email Queue bridge and inbound Email Routing forwarder
  voice/                  reusable synthesized outbound-call service
  backend/
    convex/               auth, schema, functions, HTTP routes, schedules, workpools, and generated API types
    scripts/recovery/     typed backup export and staging-only restore rehearsal commands
packages/
  client-observability/   shared browser PostHog setup, privacy filter, and release tags
  domain/                 pure rubric, routing, queue, and state-transition rules
  web-auth/               shared typed Better Auth and Convex React bridge for the browser apps
specs/                    authoritative handbook source documents
```

Convex-generated API and data-model types remain in `apps/backend/convex/_generated`. The shared domain package contains pure functions and configuration types. It does not contain a manual copy of the database schema.

Web and mobile UI packages remain separate until measured duplication appears. A small shared domain package does not force DOM and React Native components into one abstraction.

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
- The browser clients call the CORS-enabled Convex auth routes directly through the shared cross-domain adapter; Cloudflare serves no auth or application API route.
- `PARTICIPANT_SITE_URL` and `OPERATIONS_SITE_URL` are separate exact origins. Production uses HTTPS origins only; local development uses the fixed ports 5180 and 5181.
- The participant origin is the cross-domain adapter's default return destination. Operations always sends an absolute callback URL on its own trusted origin.
- After OAuth, the adapter redirects to the requesting browser origin with a three-minute single-use token. A fresh URL token always supersedes an older interrupted transfer in that tab. The origin verifies it once, immediately removes the consumed token from the address bar, and retains only the resulting session-transfer token if browser-session establishment is interrupted. Success clears that retained token. A stale account transfer can therefore neither override a newer sign-in nor be mistaken for a reusable one-time token.
- The Expo client calls the same auth base URL and returns through environment-specific deep links.
- Production trusts only the production web origin and app scheme. Development wildcard schemes never enter production configuration.
- Web, iOS, and Android Google client IDs are configured as required by the final sign-in method.
- `BETTER_AUTH_SECRET` and Google client secrets live in Convex environment variables. `BETTER_AUTH_SECRET` remains stable for the lifetime of a deployment because it encrypts Better Auth signing-key material. Rotation is a coordinated JWKS operation, not an ordinary secret replacement.
- A web-server Google OAuth client lists the exact Better Auth return URI for each backend. Local development uses `http://localhost:3211/api/auth/callback/google`; staging and production use their own exact Convex site origin plus `/api/auth/callback/google`. Scheme, host, port, path, and trailing slash must match the Google client entry exactly.
- `INITIAL_EVENT_SLUG` pins the only event an empty deployment can bootstrap. `INITIAL_SUPREME_EMAILS` is a comma-separated deployment secret used only while that configured event does not exist. It authorizes the first atomic event setup; it is not a standing role or permission check after creation.
- `ATTENDANCE_WRAPPING_KEY_VERSION` and `ATTENDANCE_WRAPPING_KEY` name the current 32-byte attendance wrapping key. During one bounded rotation, `ATTENDANCE_PREVIOUS_WRAPPING_KEY_VERSION` and `ATTENDANCE_PREVIOUS_WRAPPING_KEY` retain exactly the prior key until every event key has been authenticated and rewrapped. Current and previous versions and their decoded key bytes must both differ; a cosmetic version change cannot satisfy rotation. The same byte-distinct rule applies to the current and previous provider-token encryption keys.
- `PROVIDER_TOKEN_ENCRYPTION_KEY_VERSION` and `PROVIDER_TOKEN_ENCRYPTION_KEY` name the current 32-byte provider-secret key. During one bounded rotation, `PROVIDER_TOKEN_PREVIOUS_ENCRYPTION_KEY_VERSION` and `PROVIDER_TOKEN_PREVIOUS_ENCRYPTION_KEY` retain exactly the prior key until active Figma access/refresh tokens and every unexpired Figma PKCE verifier have been re-encrypted. The prior key also remains until every temporary GitHub user authorization has completed or reached its hard expiry of eight hours. The release commands and completion checks are documented in `README.md`.
- `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` authorize a classic OAuth App for the participant SGLang step. The callback validates state and PKCE before identifying the account, and the request asks only for `public_repo`. The backend stars SGLang, revokes the OAuth grant, and deletes the temporary encrypted token. `GITHUB_APP_ID`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY`, and `GITHUB_WEBHOOK_SECRET` belong only to the later read-only team repository integration. Each environment uses its own OAuth App with the exact `PARTICIPANT_SITE_URL/onboarding/github/callback` registration.

The application creates a `person` record after authentication. It links the Better Auth user ID and verified Google provider subject. Application tables store event access-subject state and version, participant class, organization role labels, and atomic scoped grants. The authentication session does not contain these values.

## 6. Participant auth request

1. The participant Vite client keeps the selected VIT or External path in the current browser tab and starts Google OAuth. The selection has no authorization value.
2. Better Auth creates and validates its OAuth state.
3. Google returns to the Better Auth callback on Convex.
4. Better Auth validates the provider response and creates or resumes the session.
5. The account hook records the verified Google `sub`, email, and `hd` needed by the application.
6. The portal calls `participants.provision` with the current event and selected path. The mutation derives participant class from the verified Google identity, creates or resumes the event access subject and participant membership, and materializes self-scoped membership permissions in one transaction. A VIT `hd` always produces a VIT membership. A non-VIT identity cannot use the VIT path.
7. The web client subscribes to the participant queries and routes to the first unfinished task. If the tab lost the selected path, it asks again before step 6.

The auth spike in Delivery and acceptance must prove step 5 on both web and Expo before registration work continues.

## 7. Reviewer/staff auth request

1. User opens the staff web route or reviewer app.
2. Better Auth completes Google sign-in.
3. `rosters.mine` returns only the current pending row matching the verified Google email and event; an unrostered account receives no roster context.
4. The user explicitly claims that row through `rosters.claim` with its version and an idempotency key.
5. The mutation reloads the immutable import and pinned bundle checksums. One Convex transaction links the row to the Better Auth user and Google subject. It creates or reuses the event access subject. It stores the role and materializes its code-owned template when one exists, using authority recorded when the import was confirmed. It separately expands only compatible bundle versions that the import approved into atomic grants. It then marks the row claimed. Protected functions authorize only the resulting grants, never the role string.
6. Later protected requests resolve the current permission key, validity, and exact resource scope from the linked person ID. A later CSV cannot edit the claimed row. Operators use the separately authorized role, grant, suspension, or identity-repair workflow.

React Router guards and Expo navigation can hide inaccessible screens. Convex still loads current grants in each protected query and write. A cached route or role label never gives authority.

## 8. Reads

Clients subscribe to purpose-built queries such as:

- `viewer.bootstrap`
- `intake.opening`
- `intake.current`
- `noveltyConfiguration.current`
- `participant.home`
- `participant.attendance`
- `support.mine`
- `support.staffList`
- `support.detail`
- `admissions.reviewQueue`
- `admissions.myReviewAssignments`
- `admissions.detail`
- `admissions.capacity`
- `participant.queueStatus`
- `reviewer.now`
- `reviewer.activeContext`
- `operations.roundBoard`
- `attendance.scannerNow`
- `operations.attendanceBoard`
- `operations.attendanceResultReview`
- `operations.emergencyRollCall`
- `emergencyPacks.list`
- `operations.panelDetail`
- `operations.scoreCompleteness`
- `synesthesiaParticipant.state`
- `synesthesiaConfiguration.overview`
- `synesthesiaOperations.queue`

Each query:

- resolves the current person;
- checks one required stable permission key and exact resource scope;
- uses declared indexes;
- returns only fields needed by that screen;
- avoids secret tokens and unrelated personal data.

Each Vite shell starts with only public event and authentication configuration. Protected screen data starts after the Convex client receives the verified Better Auth token. Reactive queries then keep that data current.

`README.md` and `specs/*.md` are the sole handbook source of truth. The canonical minimal reader is [code2create-specs.theg1239.chatgpt.site](https://code2create-specs.theg1239.chatgpt.site). It uses a simple password for planning access.

Do not expose generic “read any table” functions.

Admissions uses two records for different purposes. `admissionReviewAssignments` routes pending and completed work. `admissionHumanReviews` stores append-only recommendation versions.

`admissions.assignReview` resolves one exact active event-account email only after `application.assign` succeeds. One Convex transaction inserts the routing row and exact-application `application.review.read` and `application.review` source grants. It also updates the application count and version, records the operation result, and writes the audit event.

`admissions.cancelReviewAssignment` checks both record versions and revokes only the assignment source. `admissions.saveReview` compares the immutable application content version, not an unrelated routing version. Independent reviewers can therefore commit at the same time. Convex retries the count update. The transaction completes the matching active assignment once.

`admissions.detail` accepts full `application.read` or assigned `application.review.read`. The assigned view hides peer recommendations until the caller submits a review of the current content. Without `application.profile_context.read`, it omits participant class, year or institution, experience band, and band-specific guidance. Without `application.ai_recommendation.read`, it does not load the structured AI row. Decision and offer controls require their separate permissions.

The ranked admissions cohort is an action over stable `submittedAt` pagination, not one event-wide query. Each internal page loads at most 20 applications and their bounded team, proposal, review, and AI projections at one logical snapshot. The whole-event action requires explicit event-wide `application.read`; profile context and AI recommendation fields still require their separate current grants. It stops at the published 1,500-applicant-team release envelope. A state change cannot move a record behind the cursor because cohort order does not use mutable application state.

## 9. Writes

Convex mutations handle state changes. A protected mutation:

1. validates input;
2. resolves identity, the active event access subject/access version, and every candidate active grant for the command’s exact permission key;
3. loads the current records through indexes;
4. checks event/resource scope containment, grant validity/constraints, assignment, conflict, state, device, and expected version;
5. resolves a repeated operation ID when the command is high-impact;
6. writes the domain change;
7. writes a narrow audit event when required;
8. schedules external work after the transaction when required;
9. returns the accepted ID, version, and server time.

Do not perform GitHub, Figma, Expo, PostHog, or S3 network calls inside the database transaction.

Low-risk draft saves can use a compact operation ID and expected version. A score submission, page acceptance, review start, move, correction, or round change must resolve an ambiguous response before the client sends a new command.

Clients treat only Convex's `ConvexError` class as proof that an application command was rejected. Payload shape is not an error discriminator. A transport error, ordinary `Error`, timeout, or lookalike object leaves the exact immutable command and operation ID pending for replay or authoritative reconciliation. Editors lock that command's semantic target until it settles; they do not rebuild it from newer reactive versions.

Attendance scans use the same mutation rules at higher write volume. `attendance.recordScan` validates the operator, device, station configuration, credential version, session, expectation, direction, and anti-passback state. One transaction records the attempt. If accepted, it opens or closes an interval, updates the individual projection, and moves the participant between counter shards. It does not call an external service.

Staffed venue arrival is a separate online-only transaction at a provisioned `venue_entry` station. A VIT ID barcode resolves its registration number directly to one eligible, accepted RSVP member. A static external event pass resolves the external member before staff scan and visually verify the physical ID. Authorized manual fallback uses VIT registration number or external verified email. Every path creates a two-minute server record bound to the operator, phone, station, member, and resolution method.

`attendanceVenueCheckIns.record` requires the unused resolution and its exact-person permission. It creates at most one current arrival for each member and event. It records the active physical credential when present and updates one deterministic aggregate shard. It changes the team to `checked_in` only when each active member has arrived.

The separate exception path requires a current scoped authorization and reason. The separate reversal path requires another unused resolution and checks the current arrival version. It keeps the original row and updates the same shard. It can move a team from `checked_in` back to `confirmed`.

The transaction claims the resolution and changes the ledger together. Neither command writes a presence event, interval, session result, or roll-call count.

Physical credential commands use an independent one-action slot on the staffed resolution. Enroll, rebind, suspend, badge issue, badge replacement, and badge revocation must claim a fresh slot. The mutation that starts or completes the change claims it.

A second scan must present the exact claimed resolution and pending credential. The operator, phone, station, and member must match. The pending credential expires after five minutes. Client membership and credential IDs are comparison targets. They are not proof of a participant scan. One resolution can perform one credential action and one venue action. It cannot repeat either type.

Offer confirmation creates one team-availability projection from the deadline-frozen roster. Its initial inside count is zero. Each accepted venue entry or exit updates that row with the participant venue projection in one transaction. Review-board, call, start, and waiver paths read one indexed row for each team. They do not read every member venue row.

A below-minimum call writes nothing unless the same idempotent request meets three conditions. It needs `review.participant_availability.waive` for the exact team or event, recent Google authentication, and a reason. An accepted call creates one immutable review-linked waiver. The waiver contains observed and required counts and the authorizing grant IDs.

If availability drops after call, a versioned exact-review or exact-team command can create the same one-row exception while the review is pending. Start accepts the current minimum or the review's waiver. Attendance movement, call, waiver, and start use the shared team row. The projection and waiver are not judging state.

Attendance cohort creation and session close do not use one thousand-record mutations. `attendance.prepareSession` and `attendance.closeSession` create resumable internal jobs. Indexed scheduled batches process them. Open requires a complete expectation checksum. Close fixes the cutoff and version and exposes `closing`. The session reaches `closed` only after result and counter verification. These jobs do not use an external Workpool slot.

A post-session result review is a normal Convex transaction. It is not a second finalization job. Open reads the exact closed result and one-open-case index. It stores frozen versions and an evidence snapshot. Approval checks the snapshot again. It changes only the derived participant result and one counter shard. It resolves the idempotent operation and writes the case and audit record atomically. Scanner events and intervals are outside the write set. Read, open, and decide remain separate exact-session permissions.

General event support uses a separate small case and action model. It does not overload attendance remedies or incidents. Participant and roster provisioning creates revocable self create, read, and reply grants. Invitation-only subjects have no grants. Staff read and manage commands resolve exact `support_case` or event grants independently.

Create, reply, and update mutations resolve the stable actor operation before writing. Reply and staff update also check the case version. They append each visible or internal action with the case change in one transaction. The system loads owner and context IDs inside the event. These IDs do not authorize or change linked records.

Release rehearsal uses one small run, scenario, and action model. Create copies the complete server-owned 62-scenario template in one draft transaction. Manage, execute, and complete use separate exact-`rehearsal_run` or event grants. Workstream owners are active event people used only for routing. Ownership gives no access.

A scenario update checks the scenario version and appends the action in one mutation. Final completion reads all 62 current scenario rows before it changes the active run. A concurrent rerun or result change therefore conflicts. The signer cannot approve stale counts.

Roll-call start uses the prepared session's frozen cohort. At about 1,000 participants, one indexed transaction reads the cohort and current venue projections. It stores compact snapshot counts and a checksum. It initializes at most 32 fixed counter shards and does not write a duplicate participant row. An accepted venue scan also moves the expected participant's active roll-call shard before commit. Start and scan or close and scan use normal Convex conflict detection. The dashboard subscribes to the small shard set and paginated cohort roster.

An identifiable attendance export is deliberately one prepared session, not a page-by-page event dump. One internal query reads at most 1,200 cohort rows plus only the identity/profile records needed by the selected columns, so every CSV row shares one Convex logical timestamp. A dedicated two-slot Workpool uploads the spreadsheet-injection-safe CSV to the approved private KMS-backed S3 bucket and records its row count, byte count, checksum, and opaque key. The requester can obtain a signed URL bounded to the earlier of 60 seconds or export expiry only while the export is unexpired and after a second exact-permission, current authorization, version, and checksum check. No raw movement event, credential value/fingerprint, QR value, exception reason, provider secret, bucket name, or object key reaches the operations response.

The emergency-pack path is a separate bounded export workflow. A request mutation requires event-scoped `emergency_pack.prepare`, recent Google authentication, purpose, spare-sheet counts, and a stable operation ID. It reserves a collision-checked 16-hex serial prefix and enqueues generation in one transaction.

One internal query reads the accepted cohort at one logical snapshot. It also reads current team, venue-presence, station and session, round, panel, and rubric projections. The limits are 1,200 participants, 400 teams, 100 stations, ten rounds, and 400 panels. It does not assemble pages from browser subscriptions or include unaccepted applicants.

The worker builds self-contained print-first HTML. It hashes the exact source snapshot and document bytes. It writes one opaque object to KMS-encrypted versioned S3 and reads that exact version back. It marks the four-hour record ready only after size and digest verification.

`emergencyPacks.list` requires independent `emergency_pack.read`. It returns the newest ten manifests without roster rows or storage coordinates. `emergencyPackActions.print` requires independent `emergency_pack.print` and a current authorization. It signs only the recorded object version for at most 60 seconds and no longer than pack expiry. It checks record version and checksums, records the print-open audit event, and returns the URL. These commands cannot approve paper mode or import a sheet.

Judging close uses a different bounded job. The start mutation validates every team outcome and unresolved-write index, writes normalized close entries, moves the round to `closing`, and enqueues generation in the same transaction. The action pages those frozen entries, replays the fixed aggregation formula against immutable scorecard versions, builds JSON and spreadsheet-safe CSV, and uploads both to deterministic opaque S3 keys. Bucket versioning is mandatory: Convex records the exact object-version IDs, byte counts, and hashes after reading both versions back. A later action may perform storage I/O, but only a final version-checked mutation by a different authorized person may set both export and round to verified/closed.

Figma capture has one snapshot write seam. It records the raw artifact manifest, immutable snapshot, bounded preview set, selected node facts, and render enqueue in one mutation. The render action claims a five-minute lease, requests the exact Figma `version`, and downloads at most four PNGs at once from the exact Figma render host. Redirects are disabled, every request has a 30-second deadline, and any other host fails closed before a network request. Successful bytes go to content-addressed private objects outside the transaction. One completion mutation requires one result for every selected fact and the current lease. A scheduled recovery re-enqueues an expired lease, while provider `Retry-After` controls a rate-limited retry. A terminal set cannot contain pending facts, and preview failure never removes or downgrades the raw snapshot.

Reviewer layer browsing does not call Figma. An action first checks the assigned review, `review.evidence.read`, checkpoint set, binding, snapshot, and artifact manifest again. It then reads the exact gzip object from private S3. It verifies stored and decoded byte counts, SHA-256, and provider version. It returns at most 60 direct children with bounded layer, layout, component, style, text, flow, and interaction facts. Each page or opened node repeats the authorization and integrity check. The client does not receive a bucket, object key, OAuth token, or unbounded raw node.

Synesthesia performs no provider I/O. Participant requests, votes, reports, moderation, scheduling, playback acknowledgements, and access-state changes are small Convex transactions. Duplicate request/vote/report ranges and the one-playing range are read before writing, so Convex retries races against the committed state. The human operator starts/stops audio in the licensed application and records the matching acknowledgment afterward.

## 10. External I/O

Convex HTTP actions receive:

- Better Auth routes;
- GitHub App setup callback;
- GitHub signed webhooks;
- Figma OAuth callback;
- the email Worker's signed participant-email event callback;
- the signed intelligence-Worker callback at `/intelligence/operations-briefs/callback`.

Convex actions call:

- OpenAI Responses API for separately bounded intake interpretation and admission analysis;
- the private intelligence Worker for a signed operations-brief dispatch;
- GitHub repository, topic, commit, compare, tree, contents, language, and installation APIs;
- Figma metadata, full file, version, comment, image, OAuth-token, and webhook APIs;
- Firebase Cloud Messaging, Apple Push Notification service, and Cloudflare Email Sending REST API;
- S3 integration-artifact and export upload.

A heavy external workflow writes a pending domain or job record. It then adds an internal action to the applicable Workpool. The action makes the network call. An internal mutation records success, provider-directed delay, retry, or terminal failure. A Figma preview set is the rendering job record. It does not need a second generic job record. Participant email writes its dedicated delivery row and schedules one short claimed action. The two participant-intake model attempts are different: native scheduler and backend action limits bound them, while an independent server deadline materializes the published fallback after 20 seconds even if an action never starts. Intake-job operations facts are delayed background projections. A normal short run coalesces directly to its terminal fact; a job still running after 30 seconds publishes that state. Telemetry cannot fail or delay a participant answer.

Retries use provider delivery IDs or an application deduplication key. Each pool has explicit parallelism, exponential backoff with jitter, and a completion handler. A GitHub rate reset or Figma `Retry-After` replaces ordinary retry timing. Each job has a maximum attempt count. The operations and integration diagnostics screen shows the jobs.

### Reviewer push

The reviewer app registers the native token from the operating system. It does not register an Expo relay token. The server accepts only a complete Android/FCM/production or iOS/APNs/development-or-production tuple. The device record stores the provider, applicable APNs environment, token fingerprint, and current token status. Refresh replaces the token on the device. Provider rejection invalidates only the token that still matches. A late failure cannot invalidate a newer registration.

Paging writes the page and one delivery before it schedules network work. The delivery binds the exact active device and token fingerprint. The claimed action checks the page, reviewer, device, token fingerprint, and expiry again.

FCM sends through the Firebase Admin SDK. APNs sends an ES256 provider JWT over HTTP/2. It uses the sandbox or production host recorded with the token. Retryable provider failures use the bounded page-lifetime schedule. Invalid-token responses disable the matching token.

FCM message IDs and APNs IDs record only provider acceptance. The page remains pending until the reviewer accepts or declines in Convex. The deadline still starts the operations fallback.

### Participant email and external event passes

Each Convex environment sets these values:

- `CLOUDFLARE_EMAIL_ACCOUNT_ID`;
- a least-privilege `CLOUDFLARE_EMAIL_API_TOKEN`;
- `CLOUDFLARE_EMAIL_FROM`;
- optional `CLOUDFLARE_EMAIL_REPLY_TO`;
- `EMAIL_EVENT_CALLBACK_SECRET`.

External event-pass delivery additionally requires:

- a deployment-specific `WALLET_DOWNLOAD_SIGNING_SECRET` of at least 32 characters;
- `GOOGLE_WALLET_ISSUER_ID`, `GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL`, and `GOOGLE_WALLET_PRIVATE_KEY` for an issuer-authorized Google Wallet service account;
- `APPLE_WALLET_PASS_TYPE_IDENTIFIER`, `APPLE_WALLET_TEAM_IDENTIFIER`, and base64-encoded WWDR, signer certificate, and signer private-key values for Apple Wallet;
- the public `CONVEX_SITE_URL`, which owns the signed Apple Wallet download endpoint.

`PARTICIPANT_SITE_URL` supplies the authenticated return origin. It must use HTTPS outside localhost. Cloudflare Email Service must verify and enable the sending domain.

Each environment has one Cloudflare Email Sending Event Subscription for its sending domain. The subscription publishes `delivered`, `deferred`, `bounced`, `failed`, `rejected`, and `complained` events to a separate Queue. `apps/email` is the only consumer.

The Worker validates the event schema and domain. It discards subject, raw SMTP fields, and content fields. It signs the normalized event with the matching `EMAIL_EVENT_CALLBACK_SECRET`. It posts the event to `<CONVEX_SITE_URL>/communications/cloudflare-email/events`. Five failed deliveries enter the environment's dead-letter queue (DLQ).

The same Worker handles only the exact normalized `EMAIL_ROUTING_ADDRESS` alias, even if a broader Cloudflare routing rule is configured accidentally. It forwards matching messages to the verified `EMAIL_ROUTING_FORWARD_TO` mailbox. It rejects every other recipient and does not convert inbound mail into application data or commands.

One `admissions.decide` transaction writes the human decision, participant-facing state, and verified-email destination. It also writes one pending delivery for each member of the locked submitted roster. The delivery contains a generic text-template key and `/` portal path. It does not copy the decision, proposal text, novelty number, or Discord destination. The transaction schedules `participantEmail.deliver`. It does not call Cloudflare inside the mutation.

When an external participant confirms an offer, the same transaction also queues a separate `external_event_pass` delivery. Delivery creates or reuses that membership's static encrypted pass and renders its QR inline before attempting either wallet integration. Each wallet URL is isolated: an omitted, partial, invalid, or unavailable Google Wallet or Apple Wallet provider hides only that action and never blocks the inline QR or email delivery. VIT participants never receive this delivery.

The action claims a pending or due-retry delivery for 30 seconds. Before a Cloudflare call, it rechecks the application decision, active destination, recipient identity, and current Google-verified email. Each call has exactly one recipient.

A valid success contains one provider message ID. It also contains the recipient in exactly one of `delivered`, `queued`, or `permanent_bounces`. A structured provider error that proves non-acceptance can retry after five seconds and 30 seconds. The limit is three claims.

Cloudflare Email Sending does not document a request idempotency key. A timeout, invalid or contradictory success, recipient-outcome mismatch, or expired active lease becomes `unknown` immediately. The system does not reclaim or retry it automatically.

Before parsing, the Convex HTTP action verifies the Worker's bounded raw request, five-minute timestamp, and context-separated HMAC. It stores the Cloudflare event ID, provider message ID, normalized recipient, event time, safe error category, destination-disable decision, and payload hash. Duplicate event IDs must contain identical content.

An event can arrive before the send response. The system applies it after the provider message ID becomes known. Provider time and event ID define order. Duplicates and events with equal or earlier times converge.

Only a hard bounce, provider suppression, or complaint disables the exact destination. A soft exhausted bounce remains visible and does not disable it. The system does not consume open or click telemetry. Provider delivery is not participant acknowledgment.

`communications.delivery.self.read` returns only the participant's minimal current transport state. Detailed rows require `communications.delivery.read` for the exact person.

Manual retry and destination disable require `communications.delivery.manage` for the same person. They also require current versions, a reason, and a current scoped authorization. Retry creates a new linked row only from the latest definite failure. Destination disable suppresses pending and retry-wait rows. It does not change an active sending row because a provider request can already be active.

### Durable operations intelligence

Flue was selected over Eve for this service because the application is already a separate Vite deployment on Cloudflare and uses Convex, not a React/Next/Postgres agent backend. Flue compiles through Vite, runs agents in Cloudflare Workers, and supplies a Durable Object identity for each agent instance. That state is execution state only. Convex remains the event database, authorization boundary, idempotency ledger, and realtime publisher.

The requested flow is:

1. `operationsIntelligence.request` checks event-scoped `operations.intelligence.generate`, deduplicates the client operation, rejects a second active event brief, inserts the pending record, enqueues a Workpool action, and schedules the ten-minute terminal deadline.
2. The action reads the same bounded internal health projection used by the dashboard, stores that projection and its SHA-256 checksum together, then signs the exact JSON body and millisecond timestamp with `INTELLIGENCE_INGRESS_SECRET`.
3. The Worker verifies content type, byte limit, five-minute request age, HMAC context, and strict protocol shape before dispatch. The Convex brief ID is the create-only Flue instance ID, so a retry returns `already_exists` instead of submitting the model again.
4. `OperationsBrief` uses Flue's pinned OpenAI Responses provider. Its sole durable write tool posts one strictly shaped result to the configured Convex callback. The Worker exposes only a capability-protected read stream for the exact run; it exposes no raw agent router, Convex token, or domain-action tool.
5. The callback signs a different context with `INTELLIGENCE_CALLBACK_SECRET`. Convex verifies the raw body before parsing, rechecks protocol/source identity and every cited signal, requires each priority's owner and next action to come from the same cited frozen signal, and lets only the first matching callback or timeout settle the brief.
6. `operationsIntelligence.latest` publishes only the validated result to a caller with independent `operations.intelligence.read` permission.

This is intentionally stateful execution and stateless business authority. Durable messages make model/tool retries recoverable; they do not hold a participant profile, application, queue, attendance, review, score, grant, or incident truth. A later intelligence job receives its own minimal projection and tools. Observation tools may publish validated outputs. A proposed action returns to the ordinary product UI. Only a human-owned Convex command can execute it after rechecking the human's exact permission and scope, current authorization where required, target version/state, reason, and operation ID.

Flue Durable Object history and updates are the canonical intelligence transcript and lifecycle stream. Convex stores the brief result, recommendation records, authorization state, and exact run coordinates; it does not mirror token deltas, tool payloads, or conversation history. The product projection retains only permitted user/assistant text and fixed sanitized tool or subagent lifecycle fields. Hidden instructions, reasoning, data and file parts, metadata, raw tool arguments/results, and provider errors never cross the browser stream boundary.

The browser reads brief, subject-private copilot, and autonomy-run streams directly from the Worker with a Convex-minted, read-only capability valid for at most 60 seconds. A capability is bound to the exact event, agent name, instance, and route. Brief, copilot, and autonomy streams use distinct HMAC contexts and routes, so a ticket cannot replay across agents. Public live reads use Flue's durable long-poll updates only; the Worker rejects SSE so an established connection cannot outlive permission revocation indefinitely. Every follow-up request obtains or reuses only a still-valid ticket and rechecks the capability at the Worker. The browser receives the ticket, issue time, expiry, and signature, never `INTELLIGENCE_STREAM_SECRET` or a service-ingress secret.

Copilot conversation identity is an opaque deterministic HMAC of the event and active event-access subject. A turn enters through a Convex action only after `operations.intelligence.generate` succeeds, then reaches the Worker's signed service ingress with the caller's stable turn ID. A browser stream requires the independent `operations.intelligence.read` grant. Flue admission is at-least-once: an ambiguous response is retried with the same ID and exact message, while a validated same-ID/different-body conflict is final.

Autonomous operations is a separate durable agent, not a renamed proactive brief:

1. Four independent event permissions protect autonomy-policy read, whole-draft replacement, validation, and publication. Publication verifies the exact draft checksum, current event version, current scoped authorization, reason, and operation ID.
2. The immutable policy fixes `observe | recommend`, trigger severities/areas, cadence, the shared closed registry of 15 redacted read tools, typed recommendation kinds, the dashboard audience, and accountable owner. It contains no model-turn, delegation, read-byte, wall-clock, proposal, or daily cognitive quota.
3. The health and temporal-fact owners transactionally enqueue each distinct qualifying signal episode. Each inbox item freezes the high-watermark vector for every policy-allowed fact source and includes that vector in its source checksum; a signal's fingerprint includes the coordinates belonging to its currently qualifying policy areas. A scheduler enumerates every due slot. Manual requests use the same immutable semantic inbox. Exact duplicates coalesce; a busy executor never causes a distinct enabled source version, signal episode, slot, or manual request to disappear.
4. Convex fairly drains one run at a time per event policy. The run freezes policy/source provenance and uses a renewable technical lease. Every model/delegation authorization, read page, proposal, callback, and continuation rechecks current event state, policy, owner authority, kill state, and the frozen allowlist. Operations attention, review exceptions, active support work, intake and admission jobs, participant deliveries, integration jobs, round exports, Synesthesia operations, incident readiness, and attendance operations write complete redacted temporal facts in the owning domain mutation; each prior version receives a closed sequence interval. A traversal uses the source high-watermark frozen on its semantic inbox item and keyset-pages only the version effective at that sequence, so a later queued run can reconstruct its exact source episode after intervening inserts, updates, and removals. Operations health, review-round summaries, and attendance counts are captured once as immutable traversal JSON.
5. Each read is snapshot-stable and cursor-paginated. Each Flue submission processes one bounded durable work slice, persists its progress, and requests another signed continuation after the prior submission settles. Page and prompt bounds limit one request, never the total evidence, cognition, reduction, or duration of an authorized run. Product-terminal progress durably schedules private-artifact purge and places the exact strict callback in the run fence's outbox. The outbox commits its payload and wakeup together, pre-arms every retry before external I/O, and closes admission only after Convex accepts or exactly replays the callback.
6. The Worker stores bounded pages and summaries as individually bounded artifacts while retaining a lossless append-only catalog of every redacted finding and candidate. Derived records name a bounded set of exact parents, so their transitive source-leaf support remains recoverable without flattening it into one prompt or proposal. Durable reduction and support-closure cursors revisit that catalog across as many continuation submissions as needed; no bounded summary or provider response becomes the only copy of a fact. Recommend mode uploads canonical source leaves through a signed append-only hash chain, and Convex accepts the typed proposal only after the chain is sealed and its target leaf is grounded. Observe mode writes an authoritative run result only. Neither mode has an event-command tool.
7. The kill switch, policy supersession, owner revocation, or event closure revokes authority in Convex immediately and drives a durable signed Worker abort until recorded. The Worker records a run-bound cancellation fence even when no Flue instance exists; initial admission and every continuation check that same durable fence before a submission can be created. Initial and continuation signatures expire after 30 seconds. Convex persists the signing time with the outbound attempt, so a stalled action cannot resume after revocation and mint a fresh signature. It also retains an ambiguous outbound attempt for at least 60 seconds so its public abort state cannot settle while an ordinary request may still return. A not-found Flue abort is not permission to remove the Worker fence. A late accepted receipt neither revives the run nor advances its submission head and immediately re-arms the same abort. Transient Worker/provider congestion retries the same semantic work item rather than dropping or falsely completing it.

Convex remains the only authority and queue owner. Flue holds recoverable cognition and sanitized lifecycle history. The autonomous agent may read, reason, delegate, and propose without a product quota, but any materially consequential effect still goes through an explicit authorized human command.

## 11. OpenAI novelty, intake, and admission analysis

### Live novelty preview

The novelty preview is a drafting aid above the initial idea text box. It shows only one whole-number result. It does not share a contract, queue, or record with intake interpretation or admission analysis.

The request path is:

1. The browser waits for the published debounce interval after the minimum idea length, increments a local request sequence, and calls `novelty.preview` with the exact published or draft-pinned corpus ID.
2. `novelty.beginPreview` resolves the active person, team, exact proposal-write grant, current editable draft, pinned corpus, intake text limits, and `applicationsCloseAt`. It suppresses sensitive-looking text before creating a request row.
3. A repeated client request ID returns its settled result or fails if it was reused for different text. A recent successful team/corpus/input fingerprint returns from the short cache. Exact concurrent team/input work coalesces to one provider request. A sharded deployment-wide token bucket and the corpus's per-team minute budget shed excess optional checks before external work begins. `NOVELTY_GLOBAL_REQUESTS_PER_MINUTE` is set from the staging load result and the provider's observed request-limit headers.
4. The action calls `POST /v1/embeddings` with `text-embedding-3-small`, `encoding_format: float`, and no `dimensions` override. It sends the normalized complete idea once and validates one finite native 1,536-value vector. The endpoint does not receive or return a segment stream.
5. Convex performs one search against the pinned curated corpus and one against the current event team-idea index. It removes the requesting team, ignores expired editing rows, and keeps the fifty strongest distinct candidates. A retrieved saved or submitted row takes precedence over the same team's editing row; similarity breaks ties within the same lifecycle authority. Lifecycle weights are `editing: 0.5`, `saved: 0.8`, and `submitted: 1`. Similarity contributes only above the distinct boundary and reaches full weight at the common boundary. The server maps effective density through the published logarithmic curve to the whole-number result. No corpus label, theme, prompt, summary, team identity, other-team text, or vector reaches the participant.
6. `novelty.finishPreview` settles the request once. It attaches the signal to the current draft only when the saved idea fingerprint and corpus pin still match. The browser also ignores a response whose local sequence is no longer newest. A saved or submitted idea change deletes older team vectors and marks running previews stale in the accepting write transaction before replacement indexing is scheduled.

Saved-draft indexing is optional background work. A content change spreads its index action deterministically across five minutes, and a full background budget drops that attempt instead of reserving more work. Final submission indexes the immutable project version under the separate sharded reservation budget, so the submitted corpus still drains completely. `NOVELTY_INDEX_REQUESTS_PER_MINUTE` controls both paths. Each action reloads the authoritative record before provider work, the exact record/input fingerprint suppresses duplicates, and a current vector makes later duplicate work a no-op. A failed provider call gets at most two bounded retries. This work never gates save, follow-up, or submission.

The embeddings endpoint returns one JSON response and has no partial-vector stream. The UI can show **Comparing** while the request runs. It never draws an intermediate score from an incomplete vector. Provider absence, invalid width, timeout, rate limit, empty index, or stale completion returns **Unavailable**. It does not block save, follow-up, revision, or submission.

Corpus import is a separate operations flow. A holder of the exact event permissions can create one complete draft, replace its 5–300 curated entries, and publish the exact ready revision/checksum. Entry embeddings are generated before the import transaction; the transaction replaces the set only after every vector and entry validates. Publication pins future project drafts and never moves an active draft to a new corpus.

### Intake interpretation

The model is a stateless interpreter behind the participant screen. It is not a conversation store or an application authority.

The write path is:

1. `intake.saveInitialIdea` commits the participant's verbatim answer version and pins the current intake policy on the draft.
2. The first two fixed questions are inserted directly by the accepting mutation and never enter AI work. For ordinals three and four, the mutation schedules one native Node action and stores a version-bound 20-second end-to-end deadline in the same transaction. It does not write shared Workpool scheduler state on the participant path. The action's begin mutation computes a fingerprint from the draft ID, pinned policy checksum, target ordinal, and exact active answer-version IDs. An existing interpretation for that fingerprint wins.
3. The Node action calls `POST /v1/responses` only when an API key is present. Convex bounds native action concurrency, while the independent deadline guarantees the participant outcome. A missing key, provider failure, invalid output, delayed action start, or running request that reaches the total deadline writes one published fallback variant for that exact ordinal. The variant is selected deterministically from the team ID and ordinal, so teammates and retries see the same question while different teams are distributed across the reviewed pool. The browser may invoke the same idempotent settlement at the server-issued deadline; the scheduled mutation remains the offline backstop. Late work cannot reopen or replace the question.
4. The request uses `store: false`, no tools, no web access, and strict JSON Schema through `text.format`.
5. An internal mutation validates every returned key plus the generated question's purpose, length, single-question form, wording policy, source IDs, freshness, and ordinal against the pinned configuration.
6. If still current, the mutation stores the interpretation and one immutable question. Invalid, unavailable, failed, or late output stores the team's stable pre-reviewed fallback variant for that ordinal. The participant must answer all four questions, accept the freshness attestation, and confirm the final summary. A late completion cannot replace current state.

The schema returns covered purpose keys, an optional matched abstract idea-pattern key, a required generated `nextQuestion { text, purposeKey, answerLength, sourceAnswerVersionIds }`, and `stopReason: needs_question`. Structured Outputs constrains the shape and closed enums. The application still validates question text. Unknown IDs, stale sources, oversized, compound, repeated, or prohibited questions make the output unusable and select the team's published fallback variant. The two fixed questions occupy ordinals one and two. A validated model question or stable fallback variant occupies each of ordinals three and four.

Every atomic `intakePolicyVersion` freezes:

- the approved model ID or snapshot;
- system-instruction, input-redaction, question-policy, and JSON-Schema checksums;
- the two fixed questions, reviewed fallback-variant pools for the two generated slots, 140-character limit, allowed purpose keys, grounding contract, and blocked wording;
- input/output character and token limits;
- provider timeout and output-token bound;
- instruction, redaction, question-policy, schema, and evaluation-suite version labels;
- publication actor, time, and checksum.

A new model, instruction, or question policy is evaluated on staged synthetic and adversarial answers before publication. The release evidence measures relevance, ease of answering, duplication, compound questions, prohibited or personal-data topics, source attribution, length, early stop, and fallback behavior. The stored evaluation-suite version is a reference. Active drafts remain pinned. Ordinary publication has no migration path.

The provider call uses the pinned timeout and no SDK retries. A refusal, invalid schema, timeout, rate limit, missing key, or outage leaves the raw answer intact and selects the team's published fallback variant for that ordinal. A settled or stale interpretation cannot replace the question currently visible.

Only redacted project-intake text, source answer IDs, and published definitions are sent. The request excludes application identifiers, contact details, authentication data, admission state, provider credentials, reviewer material, and scores.

A versioned deterministic preprocessor replaces common contact, registration-number, credential, and secret patterns in free text. Free text cannot be guaranteed anonymous. The participant policy therefore discloses the processing and asks teams not to enter unnecessary personal data. A common-idea catalog contains only reviewed abstract patterns. It never contains prior participant submissions.

API data is not used for model training. However, the policy does not describe `store: false` as zero retention. Standard API abuse-monitoring logs can keep customer content for up to 30 days. A shorter policy requires approval and configuration for Modified Abuse Monitoring or Zero Data Retention. The published consent and retention policy must state the effective account controls.

### Admission analysis

Admission analysis is a second stateless contract and queue. Final submission commits an application with an immutable current team and proposal snapshot. A deduplicated `admission_ai` job can then read:

- the redacted submitted brief and source-linked answers;
- completeness and freshness-attestation facts;
- a deterministic team experience-band key derived under the published policy;
- the published year-adjusted admission criteria and closed output enums.

It excludes names, email, phone, registration number, institution prestige signals, raw eligibility evidence, human recommendations, decision state, capacity, attendance, integration activity, reviewer or judging records, and scores. The result contains a non-numeric `accept | waitlist | decline` recommendation, criterion assessments with source references, concise strengths and concerns, confidence and limitations, and exact proposal, policy, and model versions. Missing evidence lowers confidence and appears in concerns or limitations; it does not create a participant follow-up path.

The current lead can revise submitted proposal content before `applicationsCloseAt`. The revision transaction creates a new immutable proposal version, moves the application's current pointer, invalidates old human and AI outputs, and queues new optional analysis. A settlement for an older proposal version remains stale.

An internal completion mutation accepts the result only while every input/version still matches. It stores an immutable advisory record and updates the authorized admissions projection; it cannot call decision, offer, queue, or judging functions. Invalid output, refusal, timeout, or provider disablement records an unavailable state and leaves the human review path unchanged. The decision mutation requires an explicit human choice and records whether the AI record was used, cleared, overridden, stale, or unavailable.

A manual retry is a separate Convex mutation, not a provider fallback. It requires `application.ai_recommendation.run` for the exact application or event. The application must still be in active human review, and its current recommendation must have a definite failed or stale terminal state. The mutation compares the application version and recommendation ID, reloads the pinned published policy, model, and current proposal version, inserts one new recommendation, advances the application pointer and version, and writes the idempotency receipt and audit event in one transaction. The prior recommendation remains immutable. The run permission does not load its contents. A separate `application.ai_recommendation.read` grant controls that data.

## 12. Live updates

Convex reactive queries keep affected screens current after a committed write.

Examples:

- A novelty completion settles one request and may update the current draft signal in the same transaction. Only the newest matching idea/corpus can attach; a later response for older text remains request history and changes no participant state.
- `reviewOperations.queueTeam` atomically creates or updates the team/round row as queued, changes participant status, panel work, and operations counts, and requires `queue.manage` for that exact panel.
- `projects.submitFinal` creates the application and locks the previewed member set. Every open team and intake view receives the same committed state.
- `projects.reviseSubmitted` appends one immutable proposal version before `applicationsCloseAt`, invalidates stale review and AI output, and updates every authorized application view.
- `checkpointConfiguration.publish` supersedes one exact checkpoint plan and moves only the event default. `projectCheckpoints.saveUpdate` and `.saveFollowUp` update one optimistic shared team draft; `.submit` freezes one immutable submission. Team members and authorized operations readers converge on the same row, while no checkpoint command writes queue, review, or score state.
- Starting a review captures the latest already-submitted team checkpoint ID in the same evidence transaction that fixes GitHub/Figma snapshots. Reviewer context and the verified round export resolve that ID rather than querying whichever update is newest later.
- `admissions.decide` changes participant admission state and confirmed-capacity views, creates one delivery record per member of the deadline-frozen application roster, and unlocks selected-team next steps in the same transaction. Cloudflare email processing happens later and never substitutes for the authoritative portal state.
- Signed normalized Cloudflare Email lifecycle events update the participant's minimal delivery line and each authorized operations recipient row through the same stored delivery record.
- `pages.accept` changes reviewer Now, panel staffing, and the operations exception list.
- `reviews.start` changes participant state, reviewer context, panel row, queue, and active-review board.
- `scorecards.submit` changes the reviewer receipt and operations completeness; it does not reveal the value to other reviewers.
- `manualReviewRecords.verify` either rejects one submitted paper record or atomically creates the signed reviewers’ immutable scorecard versions, evaluation, completed review, and completed team-round state. The manual-record ID remains on the session and versions.
- `attendance.recordScan` changes the participant status, scanner receipt, session/zone counts, team availability, and an active roll call. The raw scan ledger is not a dashboard subscription.
- `attendanceVenueCheckIns.record` or `.reverse` changes one member's arrival receipt, one aggregate shard, and the participant view. When the full current roster crosses the boundary, it also changes the coarse team milestone. Presence and session views do not change.
- `attendance.closeSession` changes the session to closing immediately; small scheduled batches then publish final per-participant results and a verified closed state without blocking scans or reviews elsewhere.
- `attendanceRemedies.decide` changes one finalized participant result, the corresponding counter shard, operations detail, and the participant-facing case state in one transaction; it never changes the scan ledger or interval history.
- `attendanceRollCalls.start` publishes an auditable starting snapshot immediately; later accepted venue scans change its active sharded counts in the same mutation, while close freezes the final count object.
- A verified GitHub push changes that repository row and rebuilds the team's single indexed GitHub summary before its slower enrichment job completes. Participant and operations summaries subscribe to that row; repository detail remains a separate bounded query.
- A Figma metadata version change marks content dirty, then a completed snapshot replaces the derived design view. Each accepted connection, file, metadata, full-sync, preview, or webhook transition rebuilds that team's single indexed Figma summary in the same mutation. Participant and collapsed operations cards subscribe to the summary; one expanded team uses a separate bounded detail query.
- A Synesthesia request, vote, moderation action, report resolution, pause, or playback acknowledgment updates the participant and exact-window operations projections from the same transaction.
- A rehearsal owner assignment, run-state change, or scenario result updates the operations run counts, ownership table, filtered list, selected scenario, and append-only history from the same transaction.

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
- optional participant eligibility evidence if policy requires it.

Access uses authorized functions. A Convex storage ID is never treated as permission, and a generated Convex file URL is a bearer URL rather than an expiring authorization token. Protected small files are served through an HTTP action after an exact permission/scope check; artifacts that require expiring signed access use private S3.

Full Figma JSON, captured previews, protected attendance/round exports, and emergency-pack HTML go to private S3 because they can exceed Convex document/HTTP-response limits or need expiring signed access. Figma's temporary render URLs are consumed server-side and discarded; Convex keeps the exact-version render set, ordered frame facts, dimensions, checksums, and private manifests. The reviewer layer browser reads and verifies the pinned raw object server-side and returns one bounded child page, avoiding a fresh provider call and a raw-object URL in the ordinary inspection path. GitHub source is fetched from the selected repository at its pinned SHA when an assigned reviewer opens a file; only a short-lived encrypted blob cache may be stored. Convex keeps repository/checkpoint-set manifests, emergency-pack counts/expiry/checksums, normalized round-close entries, exact S3 object versions, hashes, and derived metrics without returning private storage coordinates through ordinary queries.

## 15. Deployment

### Web

Cloudflare deploys `apps/landing`, `apps/web`, and `apps/ops` as separate Workers static-asset applications. The public landing page sends applicants to the configured participant-portal origin and does not read private event data. All three use the official Vite plugin and `single-page-application` not-found handling. Wrangler environments use staging names for rehearsal and unsuffixed names for production.

`apps/intelligence` is another Vite-built Worker, not a static user surface. Its HTTP shell delegates signed autonomy admission, continuation, and abort to `src/routes/autonomyRoutes.ts`; separate `src/lib/autonomy*.ts` modules own fencing, transport, exhaustive traversal, orchestration, investigation, reduction, evidence, finalization, and artifact persistence. Wrangler creates the Flue Durable Object namespaces and the run-keyed autonomy admission-fence namespace under `code2create-intelligence-staging` or `code2create-intelligence`. Flue calls OpenAI Responses with the Worker's encrypted `OPENAI_API_KEY`. The staging Worker points only to staging Convex endpoints and uses staging-only HMAC secrets. It exposes `/health`; signed service ingress for briefs, copilot turns, autonomy admission, continuation, and abort; and capability-protected sanitized history/long-poll routes. It never exposes the raw Flue agent router, a browser mutation or attachment route, prompts, reasoning, metadata, or tool arguments/results.

Cloudflare Workers Builds connects each staging Worker to the repository's `staging` branch and each production Worker to `main`. Each Worker owns one application root, validates its browser build values when applicable, derives the release ID from Cloudflare's commit SHA, and runs its checked-in strict Wrangler deployment. Non-production branch builds are disabled. GitHub Actions verifies the repository but does not deploy Workers.

Staging builds use only the staging Convex deployment. Before authentication approval, operators enter each frontend domain as an exact Better Auth origin and Google return path. Final routes remain blocked until all required domains are supplied.

### Backend

Convex has separate development, staging, and production deployments. Production deploys run schema and function tests first. A function change must remain compatible with the current production reviewer build or raise the configured minimum build after devices are updated.

### Mobile

The repository commits Expo source and generates each native project afresh with `expo prebuild --clean`; generated iOS and Android trees are not release inputs. Signed-build commands require a clean commit, derive the embedded release ID from it, refuse concurrent prebuilds, and never overwrite an existing artifact. Android staging produces a release-signed APK for controlled fleet installation and production produces a signed AAB. iOS uses the local Xcode keychain and automatic provisioning to archive and export a development/ad-hoc staging IPA or App Store Connect production IPA. A release command loads only its environment's ignored `.env.staging.local` or `.env.production.local`; signing values remain there or in the platform keychain, never Gradle source or application JavaScript.

The native-build command validates the update URL, bundle/package identifiers, positive build number, Android keystore and Firebase file, Apple team/export method, and APNs environment before accepting an artifact. A development iOS export uses APNs sandbox; ad-hoc and App Store Connect exports use production APNs. Each finished artifact is written under ignored `outputs/native/` and still requires installation on the representative scanner fleet plus camera, background/resume, native-push, deep-link, update, and offline-replay rehearsal.

The update runtime follows the application version. Every native dependency or configuration change requires an application-version bump and new signed fleet build before JavaScript may depend on it. Each binary embeds its environment's HTTPS `/manifest` URL, RSA signing certificate, and expected key metadata. The private signing key remains on the release machine and is backed up in the event secret store before the first production binary is distributed.

Staging and production use separate update Workers, R2 buckets, and admin bearer tokens. SHA-256 addresses immutable assets. Release ID identifies immutable release documents.

The local publisher refuses a normal update from a dirty Git tree. It exports both platforms and verifies the private key against the embedded certificate. It signs the manifests and no-update directive. It uploads assets first. The Worker must confirm each asset before release registration. Activation occurs last.

Activation includes the release ID observed before export. It uses an R2 conditional write, so only one concurrent publisher can move a runtime pointer. Repeating registration for an existing release is idempotent.

Before a binary for a new runtime reaches a phone, release operations publishes a signed rollback-to-embedded pointer. Ordinary rollback returns that runtime to its embedded bundle. Restoring an older remote bundle requires reverting or reapplying it in a new commit and publishing a new release; release time is never forged to make an old manifest appear newer.

## 16. Secrets

| Store                             | Secrets                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Convex environment                | Better Auth secret, Google secret, OpenAI API key, PostHog project token/ingest host/release ID, GitHub App private key and webhook secret, Figma client secret, token-encryption key, attendance-key wrapping key, Firebase service account, APNs private key and identifiers, Cloudflare Email settings and event HMAC, voice Worker URL and callback HMAC, S3 restricted credential, intelligence Worker URL, and separate intelligence HMAC secrets |
| Cloudflare build environment      | Public Convex query/auth URLs, event slug, PostHog project token/ingest host, and build-only source-map upload credentials; no provider private key or handbook Markdown                                                                                                                                                                                                                                                                                |
| Update Worker environment         | Environment-specific admin token; the private R2 bucket is a binding and the update signing key is absent                                                                                                                                                                                                                                                                                                                                               |
| Intelligence Worker environment   | Encrypted `OPENAI_API_KEY`, PostHog project token/ingest host/environment/release labels, autonomy admission-fence namespace, exact Ops origin, exact Convex brief/autonomy callback, read, work-authorization, recommendation, and recommendation-evidence URLs, plus four HMAC secrets for ingress, callback/recommendation delivery, read/work authorization, and browser stream capabilities; no Convex service credential                          |
| Email Worker environment          | Exact Convex email-event callback URL, sending domain, verified Email Routing forward destination, and email-event HMAC secret; no Convex service credential or Cloudflare Email Sending API token                                                                                                                                                                                                                                                      |
| Voice Worker environment          | Public Worker origin, approved Twilio credential and sending number, Sarvam synthesis key, request HMAC, and callback HMAC; no Convex service credential, broad event credential, purpose decision, or proposal data                                                                                                                                                                                                                                    |
| Controlled mobile release machine | Update private key and publisher token, Android keystore/passwords, Firebase `google-services.json`, Apple signing/provisioning keychain, public backend/auth/update URLs, app identifiers, and PostHog symbol-upload credentials                                                                                                                                                                                                                       |
| Cloudflare Workers Builds         | Worker-specific GitHub connection and deploy token; browser build values and PostHog source-map upload credentials only where required; no Convex deploy, provider, mobile, or update-signing key                                                                                                                                                                                                                                                       |
| GitHub Actions                    | Controlled browser/provider verification credentials only; no Cloudflare deploy, mobile, or update-signing key                                                                                                                                                                                                                                                                                                                                          |

Figma OAuth grants are encrypted once per Figma App/user and referenced by team-owned file bindings. Figma webhook passcodes are random and stored encrypted or as verification hashes. GitHub installation tokens are minted when needed and not persisted after expiry.

## 17. Security boundaries

- Google proves identity; application records grant event access.
- Better Auth sessions prove the caller; Convex functions authorize only from current atomic permission grants, never the role label.
- The event access subject is the common per-person boundary. Suspension denies all grants; role removal alone does not.
- Client-supplied event, person, team, application, round, panel, review, scorecard, support-case, station, integration, permission, role, and bundle IDs are loaded and checked against the caller and event.
- Every protected function declares its catalogued permission key and scope resolver; compound flows call narrower helpers or require each additional key explicitly. CI fails on an unguarded public function, unknown key, illegal scope type, or wildcard.
- Permission bundles and role templates authorize nothing directly; only their materialized grants do.
- Grant and revoke are different permissions and commands. Each enforces its own delegation ceiling, exact resource and target-person scope, validity, source provenance, current authorization, reason, idempotency, and access-version check.
- A direct permission batch validates every selected row before writing. It changes one event access subject, cannot mix unrestricted and delegated authority, advances `accessVersion` once, and records one complete operation result and audit event. Individual grant rows remain the authorization source of truth.
- A camera-decoded VIT ID barcode value is sent only to the authorized attendance command, converted into an event-scoped keyed fingerprint, and discarded. Raw values never become account identity, records, logs, or exports.
- External-badge and event-pass QR bearers contain no identity. A public action validates the exact 32-byte base64url shape and derives an event HMAC. Badge bearers enter no table; the static event-pass bearer is encrypted with the event key and only its HMAC is indexed. Audit, logs, exports, and operations UI never receive either bearer.
- Station mode, direction, zone, and attendance session are server-owned configuration. A card, badge, or participant cannot select the transition.
- Provider callbacks use exact allowlisted URLs and validated state.
- Participant answers are untrusted model input. Both OpenAI contracts have no tools, credentials, score data, or write capability. Admission analysis also excludes human recommendations, capacity, and judging context.
- Novelty input is checked for common contact, registration-number, and secret patterns before provider work. Preview rows retain only the input fingerprint and character count; vectors remain on curated corpus entries, and the novelty signal is not copied into an application, admission input, review evidence, or score.
- Intelligence dispatch, callback, read, and stream capabilities use context-separated HMAC keys of at least 32 UTF-8 bytes, bounded raw bodies, closed schemas, and fixed replay or expiry windows. Convex accepts the intelligence Worker location only as one canonical origin: HTTPS outside loopback development, with no credentials, trailing slash, path, query, or fragment. Brief callbacks must match the frozen source checksum. The Worker has no broad Convex credential and its model tools can only perform the named redacted reads or publish a human-controlled recommendation or brief.
- Automatic autonomy requires the event's current published autonomy policy, active scheduler state, accountable-owner grants, and live event. Health materialization transactionally appends each changed qualifying signal episode to the semantic inbox; the internal scheduler adds every due schedule slot and fairly claims only an authorized inbox head. Runs use renewable infrastructure leases and idempotent operation receipts without cognitive quotas. The Worker cannot create or edit policy state and can publish only typed human-approval recommendations.
- Durable agent state is not a grant or domain record. A model-authored proposed action cannot cross into an event mutation; the normal human command rechecks identity, exact grant/scope, current authorization where required, state/version, reason, and operation ID.
- GitHub webhook signatures are verified against the raw body before JSON parsing affects state.
- Figma webhook passcodes, webhook IDs, file keys, event timestamps, and deduplication keys are checked before a provider event changes state.
- Logs redact cookies, authorization headers, provider tokens, participant phone numbers, support descriptions/replies, and private notes.
- Artifact/export credentials can write only to the event’s bucket prefixes.
- Production support never edits Convex tables from the dashboard console as a normal operating method; protected maintenance functions record changes.

## 18. Observability

- The landing, participant, and operations web applications send page views, page leaves, privacy-filtered click/change/submit autocapture, dead clicks, heatmaps, Web Vitals, network timing, exceptions, release ID, environment, and non-sensitive product events to PostHog. Feature flags and dashboard-controlled surveys are enabled.
- Web session replay is enabled with useful project and workflow content visible. Inputs and text are masked only when their field metadata or surrounding component identifies PII, identity, credentials, phone/OTP, participant profiles, rosters, support, or operations-intelligence content; email, phone, and VIT registration patterns are also redacted wherever they appear. Idea descriptions and follow-up answers remain visible unless they contain one of those PII patterns. Request and response headers and bodies are excluded, URLs are sanitized, and explicit `.ph-no-capture`, `[data-ph-no-capture]`, and `[data-posthog-block]` regions are omitted. Console replay is disabled because application errors can contain participant or provider material.
- The reviewer app sends screens, lifecycle events, touch autocapture limited to explicit test identifiers, native crashes, exceptions, and masked session replay. Replay masks text inputs, images, sandboxed views, and application logs.
- Convex and the intelligence Worker send PostHog AI-generation, embedding, and tool-span events for every production model path. These events carry trace/session correlation, model and provider, latency, outcome, finish reason, token/cache/reasoning usage, provider request ID, and cost when the provider reports it. They never carry prompts, participant answers, retrieved snapshots, model output, request bodies, tool arguments/results, signatures, or secrets.
- The intelligence Worker also sends bounded route/status/duration and lifecycle events. Client semantic events cover profile completion, phone verification outcomes, team creation/join, idea and follow-up saves, final application submission, admission review/decision work, AI recommendation reruns, and result release without names, text, phone numbers, team codes, notes, or domain record IDs.
- `POSTHOG_PROJECT_TOKEN` and `POSTHOG_HOST` configure server ingestion; `C2C_DEPLOYMENT_ENVIRONMENT` and `C2C_RELEASE_ID` label it. Missing server configuration is a deliberate no-op so telemetry cannot break participant or operator work. Delivery failures emit one generic local warning and never include an event payload.
- Convex logs function errors, external-job attempts, and scheduled-work failures.
- Intake diagnostics show model latency, timeout/refusal/schema-failure/question-policy-rejection/fallback rates, token usage, and configuration version without logging answer or generated-question text.
- Novelty diagnostics show request state, latency, failure category, pinned corpus version, and bounded aggregate volume. They do not log idea text, fingerprints, vectors, similarities, or participant scores.
- Admission diagnostics show job state, latency, invalid/stale/unavailable rates, policy/model version, and human used/cleared/overridden disposition without logging application text or recommendation explanations.
- Integration diagnostics show Workpool backlog, provider rate-limit windows, webhook age, metadata age, full-snapshot age, and incomplete/truncated results.
- Attendance diagnostics show scan latency/outcome, station heartbeat, pending replay age, credential anomalies, projection/counter consistency, and zone/session exception counts without logging bearer values.
- Synesthesia diagnostics show active-window state, request/moderation counts, open reports, playback pause, stale-write failures, and acknowledgment age without logging participant notes or report text.
- Event-scoped `operations.health.read` returns only bounded counts, oldest observation, owner, and next action across current intake/admission work, participant delivery, attendance, review, export, integration, incident, and Synesthesia state. Underlying text, identities, provider codes, resource names, object keys, and judging values stay behind their separate reads.
- Operations-intelligence diagnostics report request/dispatch/callback state, age, terminal category, source projection time, agent version, and model ID. Logs and Cloudflare traces exclude the frozen snapshot, prompt, model output, callback body, signatures, and secrets.
- Support diagnostics use case state, age, and bounded counts only. Descriptions, contact routes, public replies, and internal notes stay inside exact support reads and never enter aggregate health or PostHog.
- One 30-second server cron targets at most two event rows and enforces the deployment's single-event invariant. Its internal action runs the bounded aggregate internal query once, then an indexed mutation upserts exactly one `operationsHealthSnapshots` row for the event. Each generation schedules a generation-checked stale marker, so subscribers receive a server-owned stale transition if refresh work stops. Browser and mobile clients subscribe only to that row and do not run timers or pass non-semantic refresh arguments. Missing and stale materializations are explicit states; no client, intelligence read, or brief path falls back to the broad live query.
- A provisioned scanner sends an authenticated heartbeat every 45 seconds only while its camera-ready scanner surface is foregrounded. The server rechecks the exact station grant, configuration version, device assignment, and hashed installation secret, and writes at most once per 30 seconds. During a live event, an expected active station becomes stale after two minutes; registration time or an old scan alone is not treated as current liveness.
- GitHub Actions records verification results. Cloudflare Workers Builds records the build and deployment tied to each staging or production Worker and Git commit.

Business history stays in domain records and audit events. PostHog is not the judging ledger.

## 19. Architecture acceptance

- Google sign-in works on the participant and operations Vite origins and a signed Expo build through the same Better Auth instance.
- The canonical handbook mirror renders the repository Markdown and does not become a separate source of truth.
- No Clerk package, environment, issuer, or user ID appears in the product repository.
- An auth session alone cannot read event data without an active application grant.
- A role label alone cannot read event data; a person of any role can use a manually granted permission only inside its exact scope and validity.
- A role-less explicitly invited account can receive one manual grant; a globally known person without an active event access subject cannot.
- Revoking a permission blocks the next query/write while leaving unrelated grants intact.
- Support self, exact-case, and event-wide boundaries fail independently; owner/context links grant nothing, internal actions never reach a reporter, and a lost-response retry creates no duplicate case or action.
- Rehearsal exact-run and event-wide boundaries fail independently across read, manage, execute, and complete; ownership grants nothing, stale/duplicate updates cannot rewrite a terminal action, and sign-off cannot race a scenario out of `passed`.
- Grant-only authority cannot revoke, revoke-only authority cannot grant, and a scoped delegator cannot act beyond its one key/resource/target/expiry ceiling.
- Role assignment, roster import, person lookup, grant inspection, bundle publication/application/migration, granting, and revoking each fail independently without their own permission.
- Applying a bundle produces inspectable atomic grants. Migrating up to five selected prior applications is one preview-bound transaction that supersedes only their source grants, preserves explicit revocation exceptions, and cannot overwrite a concurrent manual or independently sourced grant.
- Web and mobile see one accepted test mutation live.
- An enrolled VIT ID barcode, external-badge QR, and static external event pass reach one attendance command and produce the same participant-scoped transition.
- At most one static external pass exists per accepted external membership. Repeated portal loads and delivery retries return the same encrypted bearer; only an explicit suspension makes it stop resolving.
- A staffed arrival record, identity exception, and reversal each require their own exact-person permission; only the exception and reversal require current scoped authorization. One active row, its sharded count, and the team milestone change transactionally while presence, sessions, and roll calls remain unchanged.
- A scan updates participant, scanner, operations, team-availability, zone, and roll-call views without scanning the raw event ledger.
- A below-minimum team remains queued and a below-minimum pending review cannot start unless one freshly authenticated exact-team/review availability waiver exists; that immutable row applies to one review and changes no attendance or judging fact.
- A scanner stores a bounded short-lived SQLCipher queue before network transmission, never claims local acceptance, and replays the same operation ID in device sequence. VIT ID, static external-pass, and event-badge scans use this same queue. A replay older than current accepted evidence adds a needs-review event without changing the projection.
- Simultaneous credential methods, offline replay, VIT ID barcode suspension/rebinding, external-badge replacement/revocation, and session close cannot create duplicate intervals or silently overwrite a newer presence state. VIT suspension cancels a pending successor atomically; a version-checked expiry cannot change it afterward, and only an independently authorized rebind to a different card can replace the suspended row.
- Overlapping optional/cohort sessions keep separate attendance rows, and large-cohort expectation/finalization work is resumable after function failure.
- Concurrent post-session review opens produce one open case; a stale or duplicate decision cannot overwrite a newer result or move counters twice.
- Concurrent roll-call starts for one zone produce one active record, and a scan racing start or close appears on exactly one side of the frozen boundary without being lost or counted twice.
- An emergency pack snapshots accepted participants and current operations once, exposes only protected metadata, stores one checksum-verified exact S3 version, and cannot be printed after expiry or used as manual-mode authority.
- A stale or duplicate high-impact write cannot create a second review, assignment, or scorecard.
- Two Synesthesia requests for one track converge on one row, one participant holds at most one vote/report per request, and two playback starts cannot produce two playing rows.
- Synesthesia permission checks separate catalog, window, queue, moderation, scheduling, playback, report, and participant-access authority; a music suspension touches no event account or judging record.
- External provider failure cannot hold open a Convex transaction.
- One operations-brief request freezes one redacted health snapshot before dispatch. Retrying the dispatch creates no second agent, and a mismatched checksum, invalid citation, late callback, timeout, or competing callback cannot replace the first terminal result.
- `operations.intelligence.read` and `operations.intelligence.generate` fail independently. Neither permission exposes a drill-down, and the Worker exposes no event command even when both are held.
- Autonomy-policy read, draft, validation, publication, and kill authority fail independently. Concurrent evaluation coalesces only exact duplicate work; distinct signal episodes, schedule slots, and manual requests remain durably queued and eventually execute without a cognitive quota.
- Both fixed answers are durable before model work begins; OpenAI failure selects the published fallback for the current generated slot and cannot block submission.
- A novelty preview uses the native 1,536-value `text-embedding-3-small` output and a corpus-filtered vector search. A stale response cannot attach to newer text, a duplicate request cannot create a second row, sensitive-looking input creates no request, and every failure leaves intake usable.
- A successful introduction contains two fixed answers and two generated-or-fallback answers. Each question is short, single-purpose, immutable, and tied to the source/configuration versions that produced it.
- Model output cannot call a mutation, select a phase, accept the freshness attestation, change a participant answer, publish a proposal, or reach judging data.
- Final submission starts with one optimistic transaction over the previewed draft, authoritative roster counts, and lead. That transaction installs a transient materialization guard and creates a durable attempt. Bounded idempotent mutations then materialize the immutable member snapshot and finalize the application. A concurrent change forces a new preview. A failed materialization releases the guard and preserves a bounded failure reason.
- Before the applicable server deadline, a valid membership or leadership change and each lead proposal revision appends an immutable application version and invalidates stale human and AI outputs. The team change and version advance share one Convex transaction.
- Admission analysis is versioned, structured, non-numeric, and optional to human review. It cannot publish or order a decision, and its output never reaches judging context.
- A published human decision and its per-member delivery records commit without waiting for Cloudflare. Generic email contains no decision/project content, only explicit non-acceptance is retried, ambiguous/expired requests become `unknown`, signed duplicate/out-of-order lifecycle events converge, and delivered never means read.
- Participant delivery detail and controls resolve exact-person communications grants independently. A manual retry requires the latest definite failure, current delivery/destination/application/email context, fresh auth, reason, and operation ID; `unknown` cannot be resent through that path.
- Every submitted follow-up preserves its immutable question and participant answer snapshot.
- A burst of provider events stays inside configured Workpool concurrency and does not starve review writes.
- One team can add repositories from several GitHub App installations, classify and reorder them, and freeze all of them in one review checkpoint set.
- Team integration access follows the team binding even when the Figma authorizer changes.
- Production secrets do not appear in web/mobile bundles, logs, source control, or push payloads.
- Current production mobile builds remain compatible through a backend deploy and rollback rehearsal.

## References

- [Better Auth Convex integration](https://better-auth.com/docs/integrations/convex)
- [Better Auth Expo integration](https://better-auth.com/docs/integrations/expo)
- [Cloudflare Vite plugin](https://developers.cloudflare.com/workers/vite-plugin/)
- [Cloudflare SPA static assets](https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/)
- [Flue Cloudflare target](https://flueframework.com/docs/guide/cloudflare-target/)
- [Flue routing](https://flueframework.com/docs/guide/routing/)
- [Flue agent API](https://flueframework.com/docs/reference/agent-api/)
- [Flue tools](https://flueframework.com/docs/guide/tools/)
- [Convex realtime queries](https://docs.convex.dev/realtime)
- [Convex transactions and optimistic concurrency](https://docs.convex.dev/database/advanced/occ)
- [Convex scheduling and durable function components](https://docs.convex.dev/scheduling/overview)
- [Convex limits](https://docs.convex.dev/production/state/limits)
- [Convex Workpool](https://github.com/get-convex/workpool)
- [OpenAI Responses API](https://developers.openai.com/api/reference/resources/responses)
- [OpenAI embeddings guide](https://developers.openai.com/api/docs/guides/embeddings)
- [Cloudflare Email Sending REST API](https://developers.cloudflare.com/email-service/api/send-emails/rest-api/)
- [Cloudflare Email Sending event subscriptions](https://developers.cloudflare.com/email-service/platform/event-subscriptions/)
- [Cloudflare Email Routing Worker API](https://developers.cloudflare.com/email-service/api/route-emails/email-handler/)
- [Cloudflare Queues consumer configuration](https://developers.cloudflare.com/queues/configuration/configure-queues/)
- [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [OpenAI evaluation best practices](https://developers.openai.com/api/docs/guides/evaluation-best-practices)
- [OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data)
- [Expo Notifications native device tokens](https://docs.expo.dev/versions/latest/sdk/notifications/)
- [Firebase Admin Cloud Messaging](https://firebase.google.com/docs/cloud-messaging/send/admin-sdk)
- [Apple token-based APNs connections](https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns)
- [Expo Updates protocol](https://docs.expo.dev/technical-specs/expo-updates-1/)
- [Expo local application builds](https://docs.expo.dev/guides/local-app-overview/)
- [Cloudflare R2 Workers API and conditional writes](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
- [Cloudflare R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/)
- [Expo development builds](https://docs.expo.dev/develop/development-builds/introduction/)
- [Expo custom native code](https://docs.expo.dev/workflow/customizing/)
- [Expo Camera barcode scanning](https://docs.expo.dev/versions/latest/sdk/camera/)

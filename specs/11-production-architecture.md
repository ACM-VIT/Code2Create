# Production architecture

## 1. Selected stack

| Layer | Technology |
| --- | --- |
| Language | TypeScript |
| Workspace | pnpm workspaces |
| Participant and operations web | Vite, React, and React Router SPAs |
| Canonical handbook mirror | Minimal password-gated ChatGPT Sites reader generated from repository Markdown |
| Optional handbook integration | Vite, React, and React Router SPA with Google identity and `handbook.read` |
| Reviewer/event-operations mobile | Expo, React Native, Expo Router |
| Authentication | Better Auth, Google provider only |
| Better Auth database/host | Convex component via `@convex-dev/better-auth` |
| Application backend | Convex database, queries, mutations, actions, HTTP actions, scheduler, and file storage |
| Live client updates | Convex reactive queries |
| Live novelty signal | OpenAI `text-embedding-3-small` at its native 1,536 dimensions plus a corpus-filtered Convex vector index; one atomic response per debounced preview |
| Project-intake interpretation | OpenAI Responses API with strict Structured Outputs, called only from a Convex action |
| Admission analysis | A separate OpenAI Structured Outputs contract, configuration, and bounded Convex action; human decisions remain authoritative |
| Durable intelligence | Flue on a separate Vite-built Cloudflare Worker, Cloudflare Workers AI, and one Durable Object agent instance per job identity; Convex remains authoritative |
| External job control | `@convex-dev/workpool` with separate bounded intake, admission-analysis, intelligence-dispatch, GitHub, Figma, and export pools; short participant-email sends use claimed Convex scheduler actions |
| Provider integrations | GitHub App installation tokens/webhooks and Figma OAuth/Webhooks V2 |
| Participant status email | Cloudflare Email Sending REST API, lifecycle Event Subscription to Queues, a small HMAC bridge Worker, and Cloudflare Email Routing for the approved inbound support alias; generic text links back to authenticated portal state |
| Mobile camera | `expo-camera` for VIT ID barcodes, external badges, attendance portal QR, review-presence QR, and hall-location QR; explicit app modes keep each purpose on its own permission and server command |
| Mobile notifications | Native tokens through `expo-notifications`; direct Firebase Cloud Messaging and Apple Push Notification service sends |
| Mobile protected storage | `expo-secure-store`; SQLCipher-backed `expo-sqlite` for one active draft |
| Web hosting | Cloudflare Workers static assets through `@cloudflare/vite-plugin` |
| Mobile build/release | Local Expo prebuild plus signed Gradle/Xcode artifacts; event-owned Expo Updates Worker and private R2 buckets |
| Crash reporting | Sentry for web and mobile |
| Large artifacts and recovery copy | Private AWS S3 bucket in `ap-south-1`, versioned and encrypted with KMS, for evidence, protected exports, expiring emergency packs, and recovery copies, subject to VIT data-policy approval |
| CI | GitHub Actions |
| Tests | Vitest, Convex function tests, Playwright, Maestro, and a Convex load driver |

The repository locks all dependency versions. The team upgrades them only after staging tests pass for authentication, push, camera, and reviews.

## 2. Why this shape

The event needs two client platforms and one shared live state.

- Two small Vite SPAs keep participant and operations delivery separate. All authoritative reads and writes remain in Convex.
- The canonical handbook mirror reads the repository Markdown. The optional handbook SPA tests Google identity and `handbook.read` without becoming a required production surface.
- Expo provides the native reviewer features requested in the planning discussion.
- Better Auth runs on Convex, so authentication does not add a hosted auth vendor or second auth database.
- Convex supplies transactions and reactive queries. A custom REST database and WebSocket service would repeat these functions.
- Workpool limits heavy external jobs and their retries. Participant email uses a small persistent delivery state machine and short claim lease. It retries only after explicit provider non-acceptance. One email API request does not need a pool abstraction.
- Convex stores small live projections. Compressed Figma files, captured previews, protected exports, expiring emergency packs, and downloaded backups belong in private object storage rather than one-megabyte Convex documents.
- Backup and restore run from a separate operator environment. Production export, staging import, and recovery S3 use different credentials. A browser, mobile client, or Convex function cannot start a destructive restore.
- APNs and FCM alert a reviewer. The assignment remains in Convex. Provider acceptance is not reviewer acknowledgment.
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
          optional protected handbook       ^
                                            |
Cloudflare update Worker <--> private R2 ---+

Convex -- signed frozen projection --> Flue intelligence Worker
Convex <-- signed validated callback -- Flue intelligence Worker
Flue intelligence Worker --> Cloudflare Workers AI

Convex scheduled action --> APNs / FCM --> reviewer device
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
  handbook/               optional Vite permission-gated Markdown integration
  reviewer/               Expo reviewer application
  updates/                Expo Updates protocol Worker and local signed publisher
  intelligence/           Flue/Vite Cloudflare Worker for bounded durable intelligence jobs
  email/                  Cloudflare Email Queue bridge and inbound Email Routing forwarder
  backend/
    convex/               auth, schema, functions, HTTP routes, schedules, workpools, and generated API types
    scripts/recovery/     typed backup export and staging-only restore rehearsal commands
packages/
  client-observability/   shared browser/mobile Sentry setup and release tags
  domain/                 pure rubric, routing, queue, and state-transition rules
  web-auth/               shared typed Better Auth and Convex React bridge for the three browser apps
scripts/
  generate-handbook.mjs   build the server-only Markdown module from README and specs
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
- `PARTICIPANT_SITE_URL`, `OPERATIONS_SITE_URL`, and `HANDBOOK_SITE_URL` are separate exact origins. Production uses HTTPS origins only; local development uses the fixed ports 5180, 5181, and 5182.
- The participant origin is the cross-domain adapter's default return destination. Operations and handbook always send an absolute callback URL on their own trusted origin.
- After OAuth, the adapter redirects to the requesting browser origin with a three-minute single-use token. A fresh URL token always supersedes an older interrupted transfer in that tab. The origin verifies it once, immediately removes the consumed token from the address bar, and retains only the resulting session-transfer token if browser-session establishment is interrupted. Success clears that retained token. A stale account transfer can therefore neither override a newer sign-in nor be mistaken for a reusable one-time token.
- The Expo client calls the same auth base URL and returns through environment-specific deep links.
- Production trusts only the production web origin and app scheme. Development wildcard schemes never enter production configuration.
- Web, iOS, and Android Google client IDs are configured as required by the final sign-in method.
- `BETTER_AUTH_SECRET` and Google client secrets live in Convex environment variables. `BETTER_AUTH_SECRET` remains stable for the lifetime of a deployment because it encrypts Better Auth signing-key material. Rotation is a coordinated JWKS operation, not an ordinary secret replacement.
- A web-server Google OAuth client lists the exact Better Auth return URI for each backend. Local development uses `http://localhost:3211/api/auth/callback/google`; staging and production use their own exact Convex site origin plus `/api/auth/callback/google`. Scheme, host, port, path, and trailing slash must match the Google client entry exactly.
- `INITIAL_EVENT_SLUG` pins the only event an empty deployment can bootstrap. `INITIAL_SUPREME_EMAILS` is a comma-separated deployment secret used only while that configured event does not exist. It authorizes the first atomic event setup; it is not a standing role or permission check after creation.
- `ATTENDANCE_WRAPPING_KEY_VERSION` and `ATTENDANCE_WRAPPING_KEY` name the current 32-byte attendance wrapping key. During one bounded rotation, `ATTENDANCE_PREVIOUS_WRAPPING_KEY_VERSION` and `ATTENDANCE_PREVIOUS_WRAPPING_KEY` retain exactly the prior key until every event key has been authenticated and rewrapped. Current and previous versions and their decoded key bytes must both differ; a cosmetic version change cannot satisfy rotation. The same byte-distinct rule applies to the current and previous provider-token encryption keys.
- `PROVIDER_TOKEN_ENCRYPTION_KEY_VERSION` and `PROVIDER_TOKEN_ENCRYPTION_KEY` name the current 32-byte provider-secret key. During one bounded rotation, `PROVIDER_TOKEN_PREVIOUS_ENCRYPTION_KEY_VERSION` and `PROVIDER_TOKEN_PREVIOUS_ENCRYPTION_KEY` retain exactly the prior key until active Figma access/refresh tokens and every unexpired pending or verifying PKCE verifier have been re-encrypted. The release commands and completion checks are documented in `README.md`.

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
5. The mutation reloads the immutable import and pinned bundle checksums. One Convex transaction links the row to the Better Auth user and Google subject. It creates or reuses the event access subject. It stores the non-authorizing role label. It expands only compatible bundle versions that the import approved into atomic grants. It then marks the row claimed.
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

The optional protected integration has a separate read path. Before an integration test or deployment, `scripts/generate-handbook.mjs` converts the authoritative Markdown into a server-only Convex module. The public Vite bundle contains only the reader shell. Document-list, document-body, and search queries require the caller's exact event-scoped `handbook.read` grant. Search runs on the server and returns bounded snippets. This integration is not a second source of truth or a required production surface.

Do not expose generic “read any table” functions.

Admissions uses two records for different purposes. `admissionReviewAssignments` routes pending and completed work. `admissionHumanReviews` stores append-only recommendation versions.

`admissions.assignReview` resolves one exact active event-account email only after `application.assign` succeeds. One Convex transaction inserts the routing row and exact-application `application.review.read` and `application.review` source grants. It also updates the application count and version, records the operation result, and writes the audit event.

`admissions.cancelReviewAssignment` checks both record versions and revokes only the assignment source. `admissions.saveReview` compares the immutable application content version, not an unrelated routing version. Independent reviewers can therefore commit at the same time. Convex retries the count update. The transaction completes the matching active assignment once.

`admissions.detail` accepts full `application.read` or assigned `application.review.read`. The assigned view hides peer recommendations until the caller submits a review of the current content. Without `application.profile_context.read`, it omits participant class, year or institution, experience band, and band-specific guidance. Without `application.ai_recommendation.read`, it does not load the structured AI row. Decision and offer controls require their separate permissions.

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

Do not perform GitHub, Figma, Expo, Sentry, or S3 network calls inside the database transaction.

Low-risk draft saves can use a compact operation ID and expected version. A score submission, page acceptance, review start, move, correction, or round change must resolve an ambiguous response before the client sends a new command.

Clients treat only Convex's `ConvexError` class as proof that an application command was rejected. Payload shape is not an error discriminator. A transport error, ordinary `Error`, timeout, or lookalike object leaves the exact immutable command and operation ID pending for replay or authoritative reconciliation. Editors lock that command's semantic target until it settles; they do not rebuild it from newer reactive versions.

Attendance scans use the same mutation rules at higher write volume. `attendance.recordScan` validates the operator, device, station configuration, credential version, session, expectation, direction, and anti-passback state. One transaction records the attempt. If accepted, it opens or closes an interval, updates the individual projection, and moves the participant between counter shards. It does not call an external service.

Staffed venue arrival is a separate online-only transaction at a provisioned `venue_entry` station. A fresh participant portal QR resolves the exact accepted member and team. It creates a two-minute server record that binds the operator, phone, station, and member. The operator then checks the VIT ID or approved external photo ID.

`attendanceVenueCheckIns.record` requires the unused resolution and its exact-person permission. It creates at most one current arrival for each member and event. It records the active physical credential when present and updates one deterministic aggregate shard. It changes the team to `checked_in` only when each active member has arrived.

The separate exception path requires a fresh Google session and reason. The separate reversal path requires another unused resolution and checks the current arrival version. It keeps the original row and updates the same shard. It can move a team from `checked_in` back to `confirmed`.

The transaction claims the resolution and changes the ledger together. Neither command writes a presence event, interval, session result, or roll-call count.

Physical credential commands use an independent one-action slot on the staffed resolution. Enroll, rebind, suspend, badge issue, badge replacement, and badge revocation must claim a fresh slot. The mutation that starts or completes the change claims it.

A second scan must present the exact claimed resolution and pending credential. The operator, phone, station, and member must match. The pending credential expires after five minutes. Client membership and credential IDs are comparison targets. They are not proof of a participant scan. One resolution can perform one credential action and one venue action. It cannot repeat either type.

Offer confirmation creates one team-availability projection from the locked roster. Its initial inside count is zero. Each accepted venue entry or exit updates that row with the participant venue projection in one transaction. Review-board, call, start, and waiver paths read one indexed row for each team. They do not read every member venue row.

A below-minimum call writes nothing unless the same idempotent request meets three conditions. It needs `review.participant_availability.waive` for the exact team or event, recent Google authentication, and a reason. An accepted call creates one immutable review-linked waiver. The waiver contains observed and required counts and the authorizing grant IDs.

If availability drops after call, a versioned exact-review or exact-team command can create the same one-row exception while the review is pending. Start accepts the current minimum or the review's waiver. Attendance movement, call, waiver, and start use the shared team row. The projection and waiver are not judging state.

Attendance cohort creation and session close do not use one thousand-record mutations. `attendance.prepareSession` and `attendance.closeSession` create resumable internal jobs. Indexed scheduled batches process them. Open requires a complete expectation checksum. Close fixes the cutoff and version and exposes `closing`. The session reaches `closed` only after result and counter verification. These jobs do not use an external Workpool slot.

A post-session result review is a normal Convex transaction. It is not a second finalization job. Open reads the exact closed result and one-open-case index. It stores frozen versions and an evidence snapshot. Approval checks the snapshot again. It changes only the derived participant result and one counter shard. It resolves the idempotent operation and writes the case and audit record atomically. Scanner events and intervals are outside the write set. Read, open, and decide remain separate exact-session permissions.

General event support uses a separate small case and action model. It does not overload attendance remedies or incidents. Participant and roster provisioning creates revocable self create, read, and reply grants. Invitation-only subjects have no grants. Staff read and manage commands resolve exact `support_case` or event grants independently.

Create, reply, and update mutations resolve the stable actor operation before writing. Reply and staff update also check the case version. They append each visible or internal action with the case change in one transaction. The system loads owner and context IDs inside the event. These IDs do not authorize or change linked records.

Release rehearsal uses one small run, scenario, and action model. Create copies the complete server-owned 61-scenario template in one draft transaction. Manage, execute, and complete use separate exact-`rehearsal_run` or event grants. Workstream owners are active event people used only for routing. Ownership gives no access.

A scenario update checks the scenario version and appends the action in one mutation. Final completion reads all 61 current scenario rows before it changes the active run. A concurrent rerun or result change therefore conflicts. The signer cannot approve stale counts.

Roll-call start uses the prepared session's frozen cohort. At about 1,000 participants, one indexed transaction reads the cohort and current venue projections. It stores compact snapshot counts and a checksum. It initializes at most 32 fixed counter shards and does not write a duplicate participant row. An accepted venue scan also moves the expected participant's active roll-call shard before commit. Start and scan or close and scan use normal Convex conflict detection. The dashboard subscribes to the small shard set and paginated cohort roster.

An identifiable attendance export is deliberately one prepared session, not a page-by-page event dump. One internal query reads at most 1,200 cohort rows plus only the identity/profile records needed by the selected columns, so every CSV row shares one Convex logical timestamp. A dedicated two-slot Workpool uploads the spreadsheet-injection-safe CSV to the approved private KMS-backed S3 bucket and records its row count, byte count, checksum, and opaque key. The requester can obtain a signed URL bounded to the earlier of 60 seconds or export expiry only while the export is unexpired and after a second exact-permission, fresh-auth, version, and checksum check. No raw movement event, credential value/fingerprint, QR value, exception reason, provider secret, bucket name, or object key reaches the operations response.

The emergency-pack path is a separate bounded export workflow. A request mutation requires event-scoped `emergency_pack.prepare`, recent Google authentication, purpose, spare-sheet counts, and a stable operation ID. It reserves a collision-checked 16-hex serial prefix and enqueues generation in one transaction.

One internal query reads the accepted cohort at one logical snapshot. It also reads current team, hall-location, venue-presence, station and session, round, panel, and rubric projections. The limits are 1,200 participants, 400 teams, 100 stations, ten rounds, and 400 panels. It does not assemble pages from browser subscriptions or include unaccepted applicants.

The worker builds self-contained print-first HTML. It hashes the exact source snapshot and document bytes. It writes one opaque object to KMS-encrypted versioned S3 and reads that exact version back. It marks the four-hour record ready only after size and digest verification.

`emergencyPacks.list` requires independent `emergency_pack.read`. It returns the newest ten manifests without roster rows or storage coordinates. `emergencyPackActions.print` requires independent `emergency_pack.print` and a fresh session. It signs only the recorded object version for at most 60 seconds and no longer than pack expiry. It checks record version and checksums, records the print-open audit event, and returns the URL. These commands cannot approve paper mode or import a sheet.

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

A heavy external workflow writes a pending domain or job record. It then adds an internal action to the applicable Workpool. The action makes the network call. An internal mutation records success, provider-directed delay, retry, or terminal failure. A Figma preview set is the rendering job record. It does not need a second generic job record. Participant email writes its dedicated delivery row and schedules one short claimed action.

Retries use provider delivery IDs or an application deduplication key. Each pool has explicit parallelism, exponential backoff with jitter, and a completion handler. A GitHub rate reset or Figma `Retry-After` replaces ordinary retry timing. Each job has a maximum attempt count. The operations and integration diagnostics screen shows the jobs.

### Reviewer push

The reviewer app registers the native token from the operating system. It does not register an Expo relay token. The server accepts only a complete Android/FCM/production or iOS/APNs/development-or-production tuple. The device record stores the provider, applicable APNs environment, token fingerprint, and current token status. Refresh replaces the token on the device. Provider rejection invalidates only the token that still matches. A late failure cannot invalidate a newer registration.

Paging writes the page and one delivery before it schedules network work. The delivery binds the exact active device and token fingerprint. The claimed action checks the page, reviewer, device, token fingerprint, and expiry again.

FCM sends through the Firebase Admin SDK. APNs sends an ES256 provider JWT over HTTP/2. It uses the sandbox or production host recorded with the token. Retryable provider failures use the bounded page-lifetime schedule. Invalid-token responses disable the matching token.

FCM message IDs and APNs IDs record only provider acceptance. The page remains pending until the reviewer accepts or declines in Convex. The deadline still starts the operations fallback.

### Participant decision email

Each Convex environment sets these values:

- `CLOUDFLARE_EMAIL_ACCOUNT_ID`;
- a least-privilege `CLOUDFLARE_EMAIL_API_TOKEN`;
- `CLOUDFLARE_EMAIL_FROM`;
- optional `CLOUDFLARE_EMAIL_REPLY_TO`;
- `EMAIL_EVENT_CALLBACK_SECRET`.

`PARTICIPANT_SITE_URL` supplies the authenticated return origin. It must use HTTPS outside localhost. Cloudflare Email Service must verify and enable the sending domain.

Each environment has one Cloudflare Email Sending Event Subscription for its sending domain. The subscription publishes `delivered`, `deferred`, `bounced`, `failed`, `rejected`, and `complained` events to a separate Queue. `apps/email` is the only consumer.

The Worker validates the event schema and domain. It discards subject, raw SMTP fields, and content fields. It signs the normalized event with the matching `EMAIL_EVENT_CALLBACK_SECRET`. It posts the event to `<CONVEX_SITE_URL>/communications/cloudflare-email/events`. Five failed deliveries enter the environment's dead-letter queue (DLQ).

The same Worker handles only the exact normalized `EMAIL_ROUTING_ADDRESS` alias, even if a broader Cloudflare routing rule is configured accidentally. It forwards matching messages to the verified `EMAIL_ROUTING_FORWARD_TO` mailbox. It rejects every other recipient and does not convert inbound mail into application data or commands.

One `admissions.decide` transaction writes the human decision, participant-facing state, and verified-email destination. It also writes one pending delivery for each member of the locked submitted roster. The delivery contains a generic text-template key and `/` portal path. It does not copy the decision, project text, track, or Discord destination. The transaction schedules `participantEmail.deliver`. It does not call Cloudflare inside the mutation.

The action claims a pending or due-retry delivery for 30 seconds. Before a Cloudflare call, it rechecks the application decision, active destination, recipient identity, and current Google-verified email. Each call has exactly one recipient.

A valid success contains one provider message ID. It also contains the recipient in exactly one of `delivered`, `queued`, or `permanent_bounces`. A structured provider error that proves non-acceptance can retry after five seconds and 30 seconds. The limit is three claims.

Cloudflare Email Sending does not document a request idempotency key. A timeout, invalid or contradictory success, recipient-outcome mismatch, or expired active lease becomes `unknown` immediately. The system does not reclaim or retry it automatically.

Before parsing, the Convex HTTP action verifies the Worker's bounded raw request, five-minute timestamp, and context-separated HMAC. It stores the Cloudflare event ID, provider message ID, normalized recipient, event time, safe error category, destination-disable decision, and payload hash. Duplicate event IDs must contain identical content.

An event can arrive before the send response. The system applies it after the provider message ID becomes known. Provider time and event ID define order. Duplicates and events with equal or earlier times converge.

Only a hard bounce, provider suppression, or complaint disables the exact destination. A soft exhausted bounce remains visible and does not disable it. The system does not consume open or click telemetry. Provider delivery is not participant acknowledgment.

`communications.delivery.self.read` returns only the participant's minimal current transport state. Detailed rows require `communications.delivery.read` for the exact person.

Manual retry and destination disable require `communications.delivery.manage` for the same person. They also require current versions, a reason, and a Google session created within the last 15 minutes. Retry creates a new linked row only from the latest definite failure. Destination disable suppresses pending and retry-wait rows. It does not change an active sending row because a provider request can already be active.

### Durable operations intelligence

Flue was selected over Eve for this service because the application is already a separate Vite deployment on Cloudflare and uses Convex, not a React/Next/Postgres agent backend. Flue compiles through Vite, runs agents in Cloudflare Workers, and supplies a Durable Object identity for each agent instance. That state is execution state only. Convex remains the event database, authorization boundary, idempotency ledger, and realtime publisher.

The requested flow is:

1. `operationsIntelligence.request` checks event-scoped `operations.intelligence.generate`, deduplicates the client operation, rejects a second active event brief, inserts the pending record, enqueues a Workpool action, and schedules the ten-minute terminal deadline.
2. The action reads the same bounded internal health projection used by the dashboard, stores that projection and its SHA-256 checksum together, then signs the exact JSON body and millisecond timestamp with `INTELLIGENCE_INGRESS_SECRET`.
3. The Worker verifies content type, byte limit, five-minute request age, HMAC context, and strict protocol shape before dispatch. The Convex brief ID is the create-only Flue instance ID, so a retry returns `already_exists` instead of submitting the model again.
4. `OperationsBrief` uses the environment's Workers AI binding. Its sole durable write tool posts one strictly shaped result to the configured Convex callback. The Worker exposes only a capability-protected read stream for the exact run; it exposes no raw agent router, Convex token, or domain-action tool.
5. The callback signs a different context with `INTELLIGENCE_CALLBACK_SECRET`. Convex verifies the raw body before parsing, rechecks protocol/source identity and every cited signal, requires each priority's owner and next action to come from the same cited frozen signal, and lets only the first matching callback or timeout settle the brief.
6. `operationsIntelligence.latest` publishes only the validated result to a caller with independent `operations.intelligence.read` permission.

This is intentionally stateful execution and stateless business authority. Durable messages make model/tool retries recoverable; they do not hold a participant profile, application, queue, attendance, review, score, grant, or incident truth. A later intelligence job receives its own minimal projection and tools. Observation tools may publish validated outputs. A proposed action returns to the ordinary product UI. Only a human-owned Convex command can execute it after rechecking the human's exact permission and scope, fresh authentication where required, target version/state, reason, and operation ID.

Flue Durable Object history and updates are the canonical intelligence transcript and lifecycle stream. Convex stores the brief result, recommendation records, authorization state, and exact run coordinates; it does not mirror token deltas, tool payloads, or conversation history. The product projection retains only permitted user/assistant text and fixed sanitized tool or subagent lifecycle fields. Hidden instructions, reasoning, data and file parts, metadata, raw tool arguments/results, and provider errors never cross the browser stream boundary.

The browser reads brief, subject-private copilot, and autonomy-run streams directly from the Worker with a Convex-minted, read-only capability valid for at most 60 seconds. A capability is bound to the exact event, agent name, instance, and route. Brief, copilot, and autonomy streams use distinct HMAC contexts and routes, so a ticket cannot replay across agents. Public live reads use Flue's durable long-poll updates only; the Worker rejects SSE so an established connection cannot outlive permission revocation indefinitely. Every follow-up request obtains or reuses only a still-valid ticket and rechecks the capability at the Worker. The browser receives the ticket, issue time, expiry, and signature, never `INTELLIGENCE_STREAM_SECRET` or a service-ingress secret.

Copilot conversation identity is an opaque deterministic HMAC of the event and active event-access subject. A turn enters through a Convex action only after `operations.intelligence.generate` succeeds, then reaches the Worker's signed service ingress with the caller's stable turn ID. A browser stream requires the independent `operations.intelligence.read` grant. Flue admission is at-least-once: an ambiguous response is retried with the same ID and exact message, while a validated same-ID/different-body conflict is final.

Autonomous operations is a separate durable agent, not a renamed proactive brief:

1. Four independent event permissions protect autonomy-policy read, whole-draft replacement, validation, and publication. Publication verifies the exact draft checksum, current event version, fresh Google session, reason, and operation ID.
2. The immutable policy fixes `observe | recommend`, trigger severities/areas, cadence, the shared closed registry of 15 redacted read tools, typed recommendation kinds, the dashboard audience, and accountable owner. It contains no model-turn, delegation, read-byte, wall-clock, proposal, or daily cognitive quota.
3. The health and temporal-fact owners transactionally enqueue each distinct qualifying signal episode. Each inbox item freezes the high-watermark vector for every policy-allowed fact source and includes that vector in its source checksum; a signal's fingerprint includes the coordinates belonging to its currently qualifying policy areas. A scheduler enumerates every due slot. Manual requests use the same immutable semantic inbox. Exact duplicates coalesce; a busy executor never causes a distinct enabled source version, signal episode, slot, or manual request to disappear.
4. Convex fairly drains one run at a time per event policy. The run freezes policy/source provenance and uses a renewable technical lease. Every model/delegation authorization, read page, proposal, callback, and continuation rechecks current event state, policy, owner authority, kill state, and the frozen allowlist. Operations attention, review exceptions, active support work, intake and admission jobs, participant deliveries, integration jobs, round exports, Synesthesia operations, incident readiness, and attendance operations write complete redacted temporal facts in the owning domain mutation; each prior version receives a closed sequence interval. A traversal uses the source high-watermark frozen on its semantic inbox item and keyset-pages only the version effective at that sequence, so a later queued run can reconstruct its exact source episode after intervening inserts, updates, and removals. Operations health, review-round summaries, attendance counts, and floor progress are captured once as immutable traversal JSON.
5. Each read is snapshot-stable and cursor-paginated. Each Flue submission processes one bounded durable work slice, persists its progress, and requests another signed continuation after the prior submission settles. Page and prompt bounds limit one request, never the total evidence, cognition, reduction, or duration of an authorized run. Product-terminal progress durably schedules private-artifact purge and places the exact strict callback in the run fence's outbox. The outbox commits its payload and wakeup together, pre-arms every retry before external I/O, and closes admission only after Convex accepts or exactly replays the callback.
6. The Worker stores bounded pages and summaries as individually bounded artifacts while retaining a lossless append-only catalog of every redacted finding and candidate. Derived records name a bounded set of exact parents, so their transitive source-leaf support remains recoverable without flattening it into one prompt or proposal. Durable reduction and support-closure cursors revisit that catalog across as many continuation submissions as needed; no bounded summary or provider response becomes the only copy of a fact. Recommend mode uploads canonical source leaves through a signed append-only hash chain, and Convex accepts the typed proposal only after the chain is sealed and its target leaf is grounded. Observe mode writes an authoritative run result only. Neither mode has an event-command tool.
7. The kill switch, policy supersession, owner revocation, or event closure revokes authority in Convex immediately and drives a durable signed Worker abort until recorded. The Worker records a run-bound cancellation fence even when no Flue instance exists; initial admission and every continuation check that same durable fence before a submission can be created. Initial and continuation signatures expire after 30 seconds. Convex persists the signing time with the outbound attempt, so a stalled action cannot resume after revocation and mint a fresh signature. It also retains an ambiguous outbound attempt for at least 60 seconds so its public abort state cannot settle while an ordinary request may still return. A not-found Flue abort is not permission to remove the Worker fence. A late accepted receipt neither revives the run nor advances its submission head and immediately re-arms the same abort. Transient Worker/provider congestion retries the same semantic work item rather than dropping or falsely completing it.

Convex remains the only authority and queue owner. Flue holds recoverable cognition and sanitized lifecycle history. The autonomous agent may read, reason, delegate, and propose without a product quota, but any materially consequential effect still goes through an explicit authorized human command.

## 11. OpenAI novelty, intake, and admission analysis

### Live novelty preview

The novelty preview is a drafting aid beside the initial idea text box. It does not share a contract, queue, or record with intake interpretation or admission analysis.

The request path is:

1. The browser waits for the published debounce interval after the minimum idea length, increments a local request sequence, and calls `novelty.preview` with the exact published or draft-pinned corpus ID.
2. `novelty.beginPreview` resolves the active person, team, exact `team.project.write` grant, unlocked draft, pinned corpus, and intake text limits. It suppresses sensitive-looking text before creating a request row.
3. A repeated client request ID returns its settled result or fails if it was reused for different text. A recent successful team/corpus/input fingerprint returns from the 30-minute cache. New work is limited by the corpus's per-team minute budget.
4. The action calls `POST /v1/embeddings` with `text-embedding-3-small`, `encoding_format: float`, and no `dimensions` override. It accepts exactly one finite 1,536-value vector.
5. Convex searches `noveltyCorpusEntries.by_corpus_embedding` with the pinned corpus ID as a vector-index filter. Only the nearest approved theme and reflection prompt may reach the participant; no past-project summary or vector does.
6. `novelty.finishPreview` settles the request once. It attaches the signal to the shared draft only when the team remains unlocked and the saved idea fingerprint and corpus pin still match. The browser also ignores a response whose local sequence is no longer newest.

The embeddings endpoint returns one JSON response and has no partial-vector stream. The UI may show a comparing state while the request runs, but it never draws intermediate scores from an incomplete vector. Provider absence, invalid width, timeout, rate limit, empty index, or stale completion returns an unavailable signal and leaves save, track selection, follow-ups, and submission unchanged.

Corpus import is a separate operations flow. A holder of the exact event permissions can create one complete draft, replace its 5–200 curated entries, and publish the exact ready revision/checksum. Entry embeddings are generated before the import transaction; the transaction replaces the set only after every vector and entry validates. Publication pins future project drafts and never moves an active draft to a new corpus.

### Intake interpretation

The model is a stateless interpreter behind the participant screen. It is not a conversation store or an application authority.

The write path is:

1. `intake.saveInitialIdea` commits the participant's verbatim answer version, pins the current intake policy and track catalog on the draft, and exposes the complete track list immediately.
2. The mutation enqueues one bounded Workpool action. Its begin mutation computes a fingerprint from the draft ID, pinned policy/catalog checksums, target ordinal, and exact active answer-version IDs. An existing interpretation for that fingerprint wins.
3. The action calls `POST /v1/responses` only when the pinned policy is assisted and an API key is present. Deterministic mode or a missing key writes the published fallback without a provider request.
4. The request uses `store: false`, no tools, no web access, and strict JSON Schema through `text.format`.
5. An internal mutation validates every returned key plus the generated question's purpose, length, single-question form, wording policy, source IDs, freshness, and ordinal against the pinned configuration.
6. If still current, the mutation stores the interpretation and one immutable question. Invalid or failed output writes the same ordinal's published fallback. A late completion cannot replace a current question. The participant separately chooses a track, answers or skips the question, accepts the freshness attestation, and confirms the final summary.

The schema returns at most one recommended published core-track stable key with a reason and source IDs, covered purpose keys, an optional matched abstract idea-pattern key, an optional generated `nextQuestion { text, purposeKey, answerLength, sourceAnswerVersionIds }`, and `stopReason`. Structured Outputs constrains the shape and closed enums; question text still requires application validation. Unknown IDs, unavailable tracks, stale sources, oversized, compound, repeated, or prohibited questions, and any question beyond ordinal two make the output unusable.

Every atomic `intakePolicyVersion` freezes:

- the approved model ID or snapshot;
- system-instruction, input-redaction, question-policy, and JSON-Schema checksums;
- the one-to-two introduction bound, 140-character question limit, allowed purpose keys, reviewed common-idea patterns, blocked wording, and both fallback questions;
- input/output character and token limits;
- provider timeout and output-token bound;
- instruction, redaction, question-policy, schema, and evaluation-suite version labels;
- publication actor, time, and checksum.

A new model, instruction, or question policy is evaluated on staged synthetic and adversarial answers before publication. The release evidence measures relevance, ease of answering, duplication, compound questions, prohibited or personal-data topics, source attribution, track fit, length, early stop, and fallback behavior. The stored evaluation-suite version is a reference, not proof that the backend ran the suite. Active drafts remain pinned; ordinary publication has no migration path.

The provider call uses the pinned timeout and no SDK retries. A refusal, invalid schema, timeout, rate limit, missing key, or outage leaves the raw answer intact and writes the published fallback. A settled or stale interpretation cannot replace the question currently visible.

Only redacted project-intake text, source answer IDs, and published definitions are sent. The request excludes application identifiers, contact details, authentication data, admission state, provider credentials, reviewer material, and scores.

A versioned deterministic preprocessor replaces common contact, registration-number, credential, and secret patterns in free text. Free text cannot be guaranteed anonymous. The participant policy therefore discloses the processing and asks teams not to enter unnecessary personal data. A common-idea catalog contains only reviewed abstract patterns. It never contains prior participant submissions.

API data is not used for model training. However, the policy does not describe `store: false` as zero retention. Standard API abuse-monitoring logs can keep customer content for up to 30 days. A shorter policy requires approval and configuration for Modified Abuse Monitoring or Zero Data Retention. The published consent and retention policy must state the effective account controls.

### Admission analysis

Admission analysis is a second stateless contract and queue, not another mode of the intake prompt. Final project submission first commits an immutable application with its locked member set and track. A deduplicated `admission_ai` job may then read:

- the redacted submitted brief and source-linked answers;
- completeness/freshness-attestation facts and the confirmed published track;
- a deterministic team experience-band key derived under the published policy;
- the published year-adjusted admission criteria and closed output enums.

It excludes names, email, phone, registration number, institution prestige signals, raw eligibility evidence, intake track recommendation/mismatch, human recommendations, decision state, capacity, attendance, integration activity, reviewer/judging records, and scores. The result contains a non-numeric `accept | waitlist | decline | needs_information` recommendation, criterion assessments with source references, concise strengths/concerns, no more than two proposed information questions, confidence/limitations, and exact application/policy/model versions.

An internal completion mutation accepts the result only while every input/version still matches. It stores an immutable advisory record and updates the authorized admissions projection; it cannot call decision, offer, queue, or judging functions. Invalid output, refusal, timeout, or provider disablement records an unavailable state and leaves the human review path unchanged. The decision mutation requires an explicit human choice and records whether the AI record was used, cleared, overridden, stale, or unavailable.

## 12. Live updates

Convex reactive queries keep affected screens current after a committed write.

Examples:

- A novelty completion settles one request and may update the current draft signal in the same transaction. Only the newest matching idea/corpus can attach; a later response for older text remains request history and changes no participant state.
- `reviewOperations.queueTeam` atomically creates or updates the team/round row as queued, changes participant status, panel work, and operations counts, and requires `queue.manage` for that exact panel.
- `projects.submitFinal` creates the immutable application and locks the previewed member set and core track together; every open team/intake view receives the same committed state.
- `intakeConfiguration.publish` supersedes one exact catalog and moves the event's new-draft pointer in one transaction. Participant drafts already carrying the prior catalog ID keep reading its published track rows, while the operations catalog summary and editor update immediately.
- `checkpointConfiguration.publish` supersedes one exact checkpoint plan and moves only the event default. `projectCheckpoints.saveUpdate` and `.saveFollowUp` update one optimistic shared team draft; `.submit` freezes one immutable submission. Team members and authorized operations readers converge on the same row, while no checkpoint command writes queue, review, or score state.
- Starting a review captures the latest already-submitted team checkpoint ID in the same evidence transaction that fixes GitHub/Figma snapshots. Reviewer context and the verified round export resolve that ID rather than querying whichever update is newest later.
- `admissions.decide` changes participant admission state and confirmed-capacity views, creates one delivery record per locked member, and unlocks selected-team next steps in the same transaction. Cloudflare email processing happens later and never substitutes for the authoritative portal state.
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

Cloudflare deploys `apps/web` and `apps/ops` as separate required Workers static-asset applications. It can deploy `apps/handbook` as an optional integration test. All three use the official Vite plugin and `single-page-application` not-found handling. Wrangler environments resolve to `code2create-participant-staging` and `code2create-operations-staging` for rehearsal. The optional integration resolves to `code2create-handbook-staging`. Participant and operations use the corresponding unsuffixed Workers for production. The handbook integration has no required production deployment.

`apps/intelligence` is another Vite-built Worker, not a static user surface. Its HTTP shell delegates signed autonomy admission, continuation, and abort to `src/routes/autonomyRoutes.ts`; separate `src/lib/autonomy*.ts` modules own fencing, transport, exhaustive traversal, orchestration, investigation, reduction, evidence, finalization, and artifact persistence. Wrangler creates the Flue Durable Object namespaces, the run-keyed autonomy admission-fence namespace, and the Workers AI binding under `code2create-intelligence-staging` or `code2create-intelligence`. The staging Worker points only to staging Convex endpoints and uses staging-only HMAC secrets. It exposes `/health`; signed service ingress for briefs, copilot turns, autonomy admission, continuation, and abort; and capability-protected sanitized history/long-poll routes. It never exposes the raw Flue agent router, a browser mutation or attachment route, prompts, reasoning, metadata, or tool arguments/results.

The manual GitHub release workflow selects the protected `staging` or `production` GitHub Environment. It validates HTTPS backend URLs, event slug, release ID, Sentry upload configuration, and Cloudflare credentials without printing values. It builds the participant and operations surfaces and the intelligence Worker before the first deployment. A staging run can also build the optional handbook integration. It then runs strict Wrangler deployments.

Preview and staging builds use only non-production Convex deployments. Before authentication approval, operators enter the participant and operations production domains as exact Better Auth origins and Google return paths. If they test the optional handbook integration, they also enter its staging origin and return path. Final routes remain blocked until their required domains are supplied.

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

| Store | Secrets |
| --- | --- |
| Convex environment | Better Auth secret, Google secret, OpenAI API key, GitHub App private key/webhook secret, Figma client secret, token-encryption key, attendance-key wrapping key, Firebase service account, APNs private key/key ID/team ID/topic, Cloudflare Email account ID/send token/from/reply-to and email-event HMAC secret, S3 restricted credential, intelligence Worker URL, and four separate intelligence HMAC secrets for ingress, callback/recommendation delivery, read/work authorization, and browser stream capabilities |
| Cloudflare build environment | Public Convex query/auth URLs, event slug, Sentry DSN; no provider private key or handbook Markdown |
| Update Worker environment | Environment-specific admin token; the private R2 bucket is a binding and the update signing key is absent |
| Intelligence Worker environment | Workers AI binding, autonomy admission-fence namespace, exact Ops origin, exact Convex brief/autonomy callback, read, work-authorization, recommendation, and recommendation-evidence URLs, plus four HMAC secrets for ingress, callback/recommendation delivery, read/work authorization, and browser stream capabilities; no Convex service credential or event provider secret |
| Email Worker environment | Exact Convex email-event callback URL, sending domain, verified Email Routing forward destination, and email-event HMAC secret; no Convex service credential or Cloudflare Email Sending API token |
| Controlled mobile release machine | Update private key and publisher token, Android keystore/passwords, Firebase `google-services.json`, Apple signing/provisioning keychain, public backend/auth/update URLs, app identifiers, Sentry upload token |
| GitHub Actions | Cloudflare and Convex deploy credentials scoped by protected environment; no mobile or update-signing key |

Figma OAuth grants are encrypted once per Figma App/user and referenced by team-owned file bindings. Figma webhook passcodes are random and stored encrypted or as verification hashes. GitHub installation tokens are minted when needed and not persisted after expiry.

## 17. Security boundaries

- Google proves identity; application records grant event access.
- Better Auth sessions prove the caller; Convex functions authorize only from current atomic permission grants, never the role label.
- The event access subject is the common per-person boundary. Suspension denies all grants; role removal alone does not.
- Client-supplied event, person, team, application, round, panel, review, scorecard, support-case, station, integration, permission, role, and bundle IDs are loaded and checked against the caller and event.
- Every protected function declares its catalogued permission key and scope resolver; compound flows call narrower helpers or require each additional key explicitly. CI fails on an unguarded public function, unknown key, illegal scope type, or wildcard.
- Permission bundles and role templates authorize nothing directly; only their materialized grants do.
- Grant and revoke are different permissions and commands. Each enforces its own delegation ceiling, exact resource and target-person scope, validity, source provenance, fresh authentication, reason, idempotency, and access-version check.
- A camera-decoded VIT ID barcode value is sent only to the authorized attendance command, converted into an event-scoped keyed fingerprint, and discarded. Raw values never become account identity, records, logs, or exports.
- External-badge QR bearers contain no identity. A public action validates the exact 32-byte base64url shape, derives an event HMAC and short reference, and passes only those values into transactional mutations; tables, audit, logs, exports, and UI never receive the bearer. Short-lived portal QR tokens resolve the already-authenticated event member.
- Station mode, direction, zone, and attendance session are server-owned configuration. A card, badge, or participant cannot select the transition.
- Provider callbacks use exact allowlisted URLs and validated state.
- Participant answers are untrusted model input; both OpenAI contracts have no tools, credentials, score data, or write capability. Admission analysis additionally excludes human recommendations, capacity, intake track-recommendation mismatch, and judging context.
- Novelty input is checked for common contact, registration-number, and secret patterns before provider work. Preview rows retain only the input fingerprint and character count; vectors remain on curated corpus entries, and the novelty signal is not copied into an application, admission input, review evidence, or score.
- Intelligence dispatch, callback, read, and stream capabilities use context-separated HMAC keys of at least 32 UTF-8 bytes, bounded raw bodies, closed schemas, and fixed replay or expiry windows. Convex accepts the intelligence Worker location only as one canonical origin: HTTPS outside loopback development, with no credentials, trailing slash, path, query, or fragment. Brief callbacks must match the frozen source checksum. The Worker has no broad Convex credential and its model tools can only perform the named redacted reads or publish a human-controlled recommendation or brief.
- Automatic autonomy requires the event's current published autonomy policy, active scheduler state, accountable-owner grants, and live event. Health materialization transactionally appends each changed qualifying signal episode to the semantic inbox; the internal scheduler adds every due schedule slot and fairly claims only an authorized inbox head. Runs use renewable infrastructure leases and idempotent operation receipts without cognitive quotas. The Worker cannot create or edit policy state and can publish only typed human-approval recommendations.
- Durable agent state is not a grant or domain record. A model-authored proposed action cannot cross into an event mutation; the normal human command rechecks identity, exact grant/scope, fresh session where required, state/version, reason, and operation ID.
- GitHub webhook signatures are verified against the raw body before JSON parsing affects state.
- Figma webhook passcodes, webhook IDs, file keys, event timestamps, and deduplication keys are checked before a provider event changes state.
- Logs redact cookies, authorization headers, provider tokens, participant phone numbers, support descriptions/replies, and private notes.
- Artifact/export credentials can write only to the event’s bucket prefixes.
- Production support never edits Convex tables from the dashboard console as a normal operating method; protected maintenance functions record changes.

## 18. Observability

- Sentry receives web/mobile exceptions, release ID, environment, route/screen, and non-sensitive event identifiers.
- Convex logs function errors, external-job attempts, and scheduled-work failures.
- Intake diagnostics show model latency, timeout/refusal/schema-failure/question-policy-rejection/fallback rates, token usage, skips by purpose or fallback key, and config version without logging answer or generated-question text.
- Novelty diagnostics show request state, latency, failure category, pinned corpus version, and bounded aggregate volume without logging idea text, fingerprints, vectors, nearest themes, reflection prompts, or participant scores.
- Admission diagnostics show job state, latency, invalid/stale/unavailable rates, policy/model version, and human used/cleared/overridden disposition without logging application text or recommendation explanations.
- Integration diagnostics show Workpool backlog, provider rate-limit windows, webhook age, metadata age, full-snapshot age, and incomplete/truncated results.
- Attendance diagnostics show scan latency/outcome, station heartbeat, pending replay age, credential anomalies, projection/counter consistency, and zone/session exception counts without logging bearer values.
- Synesthesia diagnostics show active-window state, request/moderation counts, open reports, playback pause, stale-write failures, and acknowledgment age without logging participant notes or report text.
- Event-scoped `operations.health.read` returns only bounded counts, oldest observation, owner, and next action across current intake/admission work, participant delivery, attendance, review, export, integration, incident, and Synesthesia state. Underlying text, identities, provider codes, resource names, object keys, and judging values stay behind their separate reads.
- Operations-intelligence diagnostics report request/dispatch/callback state, age, terminal category, source projection time, agent version, and model ID. Logs and Cloudflare traces exclude the frozen snapshot, prompt, model output, callback body, signatures, and secrets.
- Support diagnostics use case state, age, and bounded counts only. Descriptions, contact routes, public replies, and internal notes stay inside exact support reads and never enter aggregate health or Sentry.
- One 30-second server cron targets at most two event rows and enforces the deployment's single-event invariant. Its internal action runs the bounded aggregate internal query once, then an indexed mutation upserts exactly one `operationsHealthSnapshots` row for the event. Each generation schedules a generation-checked stale marker, so subscribers receive a server-owned stale transition if refresh work stops. Browser and mobile clients subscribe only to that row and do not run timers or pass non-semantic refresh arguments. Missing and stale materializations are explicit states; no client, intelligence read, or brief path falls back to the broad live query.
- A provisioned scanner sends an authenticated heartbeat every 45 seconds only while its camera-ready scanner surface is foregrounded. The server rechecks the exact station grant, configuration version, device assignment, and hashed installation secret, and writes at most once per 30 seconds. During a live event, an expected active station becomes stale after two minutes; registration time or an old scan alone is not treated as current liveness.
- GitHub Actions records build/test/deploy results.

Business history stays in domain records and audit events. Sentry is not the judging ledger.

## 19. Architecture acceptance

- Google sign-in works on the participant and operations Vite origins and a signed Expo build through the same Better Auth instance.
- When the optional handbook integration is deployed, Google sign-in works on its staging origin through the same Better Auth instance.
- The canonical handbook mirror renders the repository Markdown and does not become a separate source of truth.
- The optional handbook integration's public Cloudflare bundle contains no Markdown. A signed-in account without `handbook.read` cannot list, search, or fetch a document.
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
- An enrolled VIT ID barcode, external-badge QR, and dynamic portal QR reach one attendance command and produce the same participant-scoped transition.
- At most one portal QR is active for a participant. Mint revokes its predecessors, and the first scanner receipt after successful token resolution or staffed-participant resolution consumes the selected token and revokes any sibling in the same mutation.
- A staffed arrival record, identity exception, and reversal each require their own exact-person permission; only the exception and reversal require fresh Google authentication. One active row, its sharded count, and the team milestone change transactionally while presence, sessions, and roll calls remain unchanged.
- A scan updates participant, scanner, operations, team-availability, zone, and roll-call views without scanning the raw event ledger.
- A below-minimum team remains queued and a below-minimum pending review cannot start unless one freshly authenticated exact-team/review availability waiver exists; that immutable row applies to one review and changes no attendance or judging fact.
- A scanner stores a bounded short-lived SQLCipher queue before network transmission, never claims local acceptance, and replays the same operation ID in device sequence. A known-offline portal QR is refused, and a physical-credential replay older than current accepted evidence adds a needs-review event without changing the projection.
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
- An answer is durable before model work begins; OpenAI failure follows the configured fallback path and cannot block submission.
- A novelty preview uses the native 1,536-value `text-embedding-3-small` output and a corpus-filtered vector search. A stale response cannot attach to newer text, a duplicate request cannot create a second row, sensitive-looking input creates no request, and every failure leaves intake usable.
- A successful introduction contains one or two follow-ups; each is short, single-purpose, immutable, and tied to the source/configuration versions that produced it.
- Track selection is usable immediately after the opening answer; at most one AI recommendation may appear later, and the participant's different choice has no adverse admission effect.
- Model output cannot call a mutation, select a phase or track, accept the freshness attestation, change a participant answer, publish a brief, or reach judging data.
- Final submission starts with one optimistic transaction over the previewed draft, authoritative roster counts, lead, and track. That transaction locks the team and creates a durable attempt; bounded idempotent mutations then materialize the immutable member snapshot and finalize the project/application. A concurrent pre-lock change forces a new preview, while a failed materialization unlocks the team and preserves a bounded failure reason for the portal.
- Admission analysis is versioned, structured, non-numeric, and optional to human review. It cannot publish or order a decision, and its output never reaches judging context.
- A published human decision and its per-member delivery records commit without waiting for Cloudflare. Generic email contains no decision/project content, only explicit non-acceptance is retried, ambiguous/expired requests become `unknown`, signed duplicate/out-of-order lifecycle events converge, and delivered never means read.
- Participant delivery detail and controls resolve exact-person communications grants independently. A manual retry requires the latest definite failure, current delivery/destination/application/email context, fresh auth, reason, and operation ID; `unknown` cannot be resent through that path.
- Every submitted follow-up preserves its immutable question and participant answer snapshot; model track recommendations remain separate from the chosen track.
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

# Integrations and release

## 1. Integration rule

The connected GitHub repositories and Figma file belong to the Code2Create team record. They do not belong to the member who happens to install the GitHub App or finish Figma OAuth.

- A team lead adds, classifies, reorders, replaces, or disconnects a resource.
- Every active team member can see the same repository set, connection health, progress facts, and captured checkpoints.
- An assigned reviewer can see the immutable checkpoint attached to that review.
- SC with integrations/release duty can see live connection health and job failures across teams.
- Provider credentials never enter a participant, reviewer, or operations client.

GitHub and Figma record evidence. They do not calculate effort, originality, technical quality, or score. Every fact is labelled with its provider time, capture time, completeness, and previous checkpoint. A missing, late, rate-limited, or stale integration stays visible and the review continues with live/manual evidence.

Each GitHub repository and Figma file can be active for only one team in the same event. Board may override a genuine shared-resource case with a reason; the exception appears to every affected reviewer.

OpenAI, GitHub, Figma, Expo, S3, and Google calls happen outside Convex mutations. Every environment has separate credentials, and no external system owns authoritative event state.

## 2. OpenAI intake interpretation

Create a separate OpenAI API project and restricted service key for development, staging, and production. The key lives only in the corresponding Convex environment.

The Convex action uses the Responses API as a single-turn extraction request:

- `store: false`;
- background mode off;
- no built-in, function, web, file, or MCP tools;
- an approved model ID or snapshot from the published `intakeModelConfigVersion`;
- bounded input and output;
- strict Structured Outputs through `text.format` and the versioned `c2c_intake_interpretation` JSON Schema.

The request includes only:

- the redacted active question/answer history needed to avoid repetition;
- opaque source answer-version IDs;
- the server-assigned event phase and published question-purpose policy;
- published core/sponsor track definitions;
- allowed brief fields, prior generated-question ordinals, count/length limits, and phase fallback keys.

It excludes application-owned names, email, phone, registration number, Google claims, team invitations, auth/session data, admission state, GitHub/Figma credentials, reviewer context, and all score data. Before the request, a versioned deterministic filter replaces common contact, registration-number, URL-credential, and secret-token patterns inside participant free text. The original answer remains only in the project record; redacted request text is not copied into job or error logs.

The output is a proposal. It may contain source-linked brief drafts, published track candidates, coverage labels, and one free-text `nextQuestion`. After schema parsing, application code still rejects unknown or unpublished IDs, stale answer references, ineligible track combinations, a question after ordinal five, a disallowed purpose, more than one question, normalized duplicate wording, blocked personal/credential patterns, policy-prohibited wording, and text beyond field limits. The result cannot call a Convex function. An internal mutation writes a current valid result as an `intakeInterpretation` and the question as a separate immutable `intakeGeneratedQuestion`, both tied to exact input/config versions.

### Prompt-injection and failure handling

The system instruction states that participant text is untrusted project material and cannot modify the schema, question policy, allowed IDs, or product rules. Delimiter text alone is not treated as security. The actual boundary is no tools, a closed output schema, server-side key and question-text validation, immutable version checks, and no authoritative write path.

Each answer-set/config tuple has one deduplicated job. The `intake_ai` Workpool has independent concurrency, queue-age alerts, a short soft deadline, one bounded retry for transient failure, and a hard timeout. It never retries a safety refusal as if it were a network error.

The published phase policy supplies a deterministic fallback question for each possible next purpose and ordinal. Timeout, refusal, incomplete or content-filtered output, invalid schema, question-policy rejection, quota/rate limit, or service outage records a non-sensitive failure category and follows that edge. Raw answers and submission remain available.

### Model and prompt release

A model configuration cannot move to `published` until its evaluation suite passes:

- ordinary short and long project descriptions;
- descriptions that already answer several fields;
- vague, multilingual, typo-heavy, and code-mixed answers;
- ideas across every configured event phase;
- core-track ambiguity and sponsor eligibility;
- prompt-injection attempts and fake IDs;
- claims without evidence;
- potential repeated, compound, overlong, overly technical, market-proof, scoring, novelty, and “why should you win?” questions;
- questions that should be answerable immediately in one to three sentences and cases where the model should stop after the third, fourth, or fifth follow-up;
- sensitive personal data pasted into a project answer;
- redaction fixtures for email, phone, registration number, URL credentials, and common secret formats;
- refusal, truncation, invalid output, timeout, and late-result fixtures.

Assertions cover schema validity, source attribution, published track IDs, question relevance, easy-answer rate, length, one-question form, duplicate/prohibited-topic/PII rates, the three-to-five bound, no invented evidence, no authoritative selection, and deterministic fallback. Model or prompt changes publish a new immutable version; they do not rewrite active sessions.

The release suite uses a held-out set separate from prompt examples. Human reviewers label each question against short binary criteria: relevant to the team's text, answerable now without research, one idea, plain language, non-judgmental, and non-repetitive. Candidate and current configurations are compared on the same cases. The publication record stores thresholds and aggregate results. Opted-in production feedback adds new edge cases to a later suite; participant text does not enter an evaluation dataset by default.

### Data controls

Production sends `store: false` and does not use OpenAI Conversations or background responses. This avoids the Responses API's ordinary stored application state, but it is not the same as Zero Data Retention. By default, API abuse-monitoring logs may contain prompts and responses for up to 30 days. Before registration opens, the event privacy owner must approve the disclosed use and effective retention controls, and decide whether to seek Modified Abuse Monitoring or Zero Data Retention.

## 3. GitHub App

### Permissions and event topic

Register the production Code2Create GitHub App with:

- **Metadata: read**;
- **Contents: read**.

Subscribe only to:

- `push`;
- `installation`;
- `installation_repositories`.

The required repository topic is `code2create-7-0`. `GET /repos/{owner}/{repo}/topics` needs only Metadata read, so the production App checks it for every active repository at connection, readiness, and reconciliation.

GitHub's topic write endpoint is not a narrow “add topic” operation. `PUT /repos/{owner}/{repo}/topics` replaces the complete topic list and requires **Administration: write**. The selected production App therefore does not auto-write the topic. When it is missing, the portal shows the exact topic, asks a repository administrator to add it in GitHub, and rechecks without reinstalling the App.

If the board later requires automatic topic repair, ship it as a separate elevated App registration after security approval. That path must fetch the current list, merge `code2create-7-0`, replace the list, and read it back. Do not add Administration write to the read-only evidence App.

Do not request Contents write, Actions, Issues, pull requests, Secrets, Members, user email, or account-wide repository access. The installer chooses **Only select repositories** and grants exactly the repositories the team wants to submit.

### Repository set and kind

A team can connect several repositories under one GitHub integration, including repositories from different GitHub App installations or organisations. One integration contains the team’s complete submitted repository set.

Every active repository requires:

- one repository kind;
- a short purpose written by the team;
- tracked branch;
- optional project root when only part of a monorepo is relevant;
- display order;
- its own baseline, topic state, freshness, metrics, and checkpoint history.

Repository kind is a required enum:

| Value | Use |
| --- | --- |
| `full_product` | Full product or monorepo containing several application layers |
| `frontend` | Web or other client-facing interface |
| `backend_api` | API, server, worker, or backend service |
| `mobile_app` | Android, iOS, or cross-platform mobile client |
| `desktop_app` | Desktop client |
| `ai_ml` | Model, agent, inference, training, or evaluation code |
| `data_pipeline` | Data ingestion, transformation, analytics, or dataset tooling |
| `hardware_firmware` | Firmware, embedded software, HDL, or hardware-control code |
| `infrastructure` | Deployment, cloud, containers, observability, or infrastructure-as-code |
| `library_sdk` | Shared package, SDK, plugin, or reusable library |
| `docs_research` | Project documentation, specifications, experiments, or research material |
| `other` | Another role; a custom kind label is required |

The portal does not infer kind from languages or filenames. A team can change the kind or purpose before the integration freeze; the history records the previous values. External dependencies that the team cannot administer belong in the prior-work/tool disclosure, not in the connected-repository set.

Versioned event configuration supplies `maxActiveGitHubRepositoriesPerTeam` after the registered scale and GitHub rate budget are tested, so the limit is an explicit event policy rather than a one-repository product constraint. The UI explains the configured cap and lets a lead archive an old binding without deleting its checkpoints.

### Team connection

1. A team lead selects **Connect GitHub**.
2. The portal creates a one-use setup intent bound to event, team, person, and return route.
3. GitHub opens the App installation or repository-selection flow.
4. The callback validates the intent and resolves the installation.
5. The portal lists only repositories currently granted to that installation.
6. **Add repository** asks for repository, tracked branch, optional project root, kind, custom kind when needed, purpose, and display order.
7. The backend verifies the event cap and that the repository is not already bound to another team in the event.
8. The backend reads repository metadata, topics, languages, the tracked head, and the commit/tree at that head.
9. It records the repository baseline SHA, topic state, repository creation/fork metadata, and first immutable snapshot.
10. The lead repeats the flow for every submitted repository and can start another App installation flow when the next repository belongs to a different account or organisation.

One `teamIntegration` owns the ordered repository set. A GitHub installation can serve several repositories and several Code2Create teams, while one team can reference several installations. The application never asks for a personal access token.

### Authentication and API version

The backend signs a short-lived GitHub App JWT and mints an installation access token restricted to the repository needed by that job and to read permissions. Installation tokens expire after one hour. Mint one for a provider job, keep it only in action memory, and discard it after the call.

Every REST request sends `Accept: application/vnd.github+json` and the pinned `X-GitHub-Api-Version: 2026-03-10` header. The API version is upgraded only after fixture and staging checks pass.

### Webhook fast path

The Convex HTTP action:

1. reads the unmodified request body;
2. validates `X-Hub-Signature-256` with constant-time comparison;
3. checks `X-GitHub-Event`, installation ID, and repository ID;
4. deduplicates `X-GitHub-Delivery`;
5. resolves the repository binding, records the small provider event, and advances that repository plus the team summary projection;
6. enqueues enrichment in the bounded integration Workpool;
7. returns a 2xx response within GitHub's ten-second window.

A `push` payload supplies `ref`, `before`, `after`, `created`, `deleted`, `forced`, and up to 2,048 pushed commits. The fast path updates the team card without waiting for another API request. Events can arrive out of order, so the worker compares provider timestamps and ancestry instead of treating delivery order as commit order.

Invalid signatures, unknown repositories, repeated deliveries, unsupported event types, and oversized payloads do not change project evidence.

### Enrichment, statistics, and repository view

For each repository’s tracked branch and optional project root, the worker uses the Commits, Compare, Git Trees, Contents, repository, topic, and language endpoints. It records:

- required-topic state and first/last verified time;
- baseline SHA, current head SHA, head commit time, and ahead/behind state;
- push count, commit count, and active-hour buckets since baseline;
- additions, deletions, changed-file count, file-type mix, and top changed directories;
- GitHub user IDs/logins attached to commits, plus a separate unknown/unlinked-author count;
- language byte distribution;
- force pushes, branch creation/deletion, default-branch changes, access loss, and delivery gaps;
- last webhook time, last successful reconciliation, freshness, and completeness.

The participant and reviewer views show a repository switcher with kind, purpose, branch/root, topic, freshness, and completeness. Each repository view is pinned to that repository snapshot’s SHA. It shows the tree and can fetch a selected text file through the Contents API at that SHA. Recursive Git tree results are marked incomplete if GitHub returns `truncated`; the worker then walks subtrees or shows the limit. Binary and oversized files are metadata-only. Source blobs may use a short-lived encrypted cache during a review window, but the system does not retain a permanent clone, archive, raw diff, commit email, or secret-bearing commit message.

The team summary is materialised from the active repository bindings. It contains per-kind counts, repository count, combined activity buckets, the union of linked GitHub users, topic coverage, and `completeRepositories / expectedRepositories`. Per-repository values stay beside the combined view. A commit SHA observed in two connected forks remains visible in both repository histories but counts once in the combined commit total; the summary records the overlap. Missing, inaccessible, or truncated repositories make the combined result incomplete.

At each checkpoint, the backend captures every active repository independently, then creates one immutable checkpoint set containing the ordered repository binding/snapshot pairs and the Figma snapshot when present. A missing repository remains in the set with its failure state. Review start stores the checkpoint-set ID, so adding, removing, reordering, or refreshing a repository later cannot change the evidence already shown to reviewers.

GitHub's repository-statistics endpoints are periodic enrichment only. They can return `202` while GitHub computes a cache, reset when the default-branch SHA changes, and do not support repositories with 10,000 or more commits. Live cards therefore come from signed pushes plus commit/compare reconciliation, not the cached statistics endpoints. Compare responses also cap the changed-file list at 300, so every metric carries a completeness flag.

Counts are context. Squashes, generated files, rebases, pair programming, and Git author configuration make them unreliable as a score or as proof of individual contribution.

### Failure and revocation

- Installation removal marks every affected repository binding `revoked` and stops its jobs.
- Repository-access removal marks only that binding `inaccessible`; the other team repositories continue updating.
- Rename or transfer resolves by repository ID on reconciliation.
- A force push records the new head and a discontinuity; it never silently rewrites an earlier snapshot.
- A deleted tracked branch requires the team to choose another branch and creates a new baseline relationship.
- Rate-limit responses pause that installation's Workpool lane until reset; live clients keep the last verified data and its age.
- Removing or replacing a repository before freeze changes the active set and preserves earlier binding versions, snapshots, and checkpoint sets.

## 4. Figma OAuth and full design evidence

### Scopes

Request only:

- `file_metadata:read`;
- `file_content:read`;
- `file_versions:read`;
- `file_comments:read`;
- `webhooks:read`;
- `webhooks:write`.

The file-content scope is required because reviewers and teams need the document tree, components, styles, prototype structure, and rendered frames, not a metadata card. Comment read access supplies open/resolved collaboration context. The App never writes comments or file content.

Do not request `projects:read`, organisation scopes, variables, libraries, or write scopes in the baseline. A later event may add `file_dev_resources:read` or `file_variables:read` only after a separate feature, plan check, consent text, and review. Variables API access is not available on every Figma plan.

The portal accepts a Figma file URL instead of listing a person's projects. The backend parses the file key and first verifies it with `GET /v1/files/:key/meta`.

### Credential grant versus team ownership

Figma OAuth is granted by a person, so the encrypted token record is keyed by the Figma user ID, not copied once per team. The selected file, snapshots, metrics, and review visibility remain owned by `eventId + teamId`.

One Figma authorization may support more than one team connection if that Figma user can access those files. Refreshing it updates one credential record, avoiding the race caused by Figma maintaining one current access token per App and user. If the authorizer leaves the Code2Create team or revokes access, the team data remains and any current team lead can replace the authorization.

### Connection flow

1. A team member selects **Connect Figma**.
2. The backend creates a one-use OAuth intent bound to event, team, person, PKCE verifier, and exact callback.
3. The browser opens Figma OAuth with state and an S256 PKCE challenge.
4. The callback validates state and exchanges the 30-second authorization code at `/v1/oauth/token`.
5. The backend encrypts the access and refresh tokens and stores `user_id_string` as a string.
6. The member pastes a file URL.
7. The backend checks metadata, access role, file/main-file key, link access, current version, and whether the file is already used by another event team.
8. A team lead confirms the file.
9. The backend fetches full content, version history, comments, and selected frame renders for the baseline.
10. It attempts one file-context `FILE_UPDATE` webhook when the authorizer has **Can edit** access and the plan has capacity.

The public production OAuth App must complete Figma review before participant onboarding. Access tokens are refreshed before expiry through `/v1/oauth/token`; the legacy refresh endpoint is not used.

### Provider observation and application realtime

Convex publishes a received provider event or completed metadata check to every authorised client immediately. That does not make Figma itself instant:

- `FILE_UPDATE` can arrive only after up to 30 minutes of editing inactivity;
- a file webhook requires Can edit access;
- Figma limits file webhooks by context and plan;
- full-file and image calls are Tier 1 and can be as low as six requests per month for View or Collab seats.

The production design combines three signals:

1. A file-context `FILE_UPDATE` webhook when available. Its passcode is validated before the event is accepted.
2. A lightweight `GET /v1/files/:key/meta` heartbeat every 60–120 seconds during event/review windows and less often outside them.
3. Explicit full checkpoints at connection, before each review window, review start when stale and allowed, round close, and participant refresh.

A metadata version change marks the team view `content_dirty` immediately and coalesces one full-content job. High-rate-limit grants may refresh content after the debounce window. Low/unknown grants reserve Tier 1 calls for required checkpoints. A `429` stores `Retry-After`, `X-Figma-Plan-Tier`, and `X-Figma-Rate-Limit-Type`; no worker retries before that time.

The UI shows separate times for provider last touched, provider event observed, metadata checked, and full content captured. “Live” never hides a stale full snapshot.

### Full snapshots, previews, and statistics

`GET /v1/files/:key` returns the complete node tree when no `depth` or `ids` filter is supplied. The raw response can exceed Convex's one-megabyte document limit, so the action compresses it and writes an immutable private S3 object. Convex stores only the manifest, hashes, derived facts, and authorised preview references.

For each snapshot, derive:

- page, section, top-level frame/screen, and total node counts;
- counts by node type;
- components, component sets, variants, instances, styles, and local reuse;
- auto-layout use among eligible frame-like nodes;
- prototype flow starting points and reactions;
- text-style and font-family counts without treating text volume as quality;
- named versions and their Figma user handles;
- comment, reply, open, and resolved counts when the comment scope is active;
- per-page and per-top-level-node semantic hashes;
- added, removed, and changed top-level frames since the prior checkpoint;
- provider last-touched time and snapshot freshness.

The image endpoint renders selected top-level frames in batches. The worker downloads successful renders into the private artifact bucket before Figma's URLs expire. The portal and reviewer app can open a page/frame index, preview each captured screen, inspect the layer tree and node properties, review prototypes/components/comments, and open the original Figma file when their own Figma access allows it.

Figma does not expose keystrokes, edit duration, every autosave, or reliable per-person contribution. Version/comment handles and changed-node counts are labelled as observed activity, not authorship or effort.

### Failure, revocation, and webhook limits

- Wrong passcode, unknown webhook/file, or duplicate `{webhook_id, event_type, file_key, timestamp}` is rejected or ignored.
- `PING` proves endpoint setup but does not create a project snapshot.
- Expired or invalid OAuth credentials mark every dependent team binding `reauth_required`.
- File permission loss marks only that file binding `inaccessible`.
- A paused/error webhook falls back to metadata heartbeat and appears in integration diagnostics.
- A View-only authorizer can still supply content if the API allows it, but cannot create the file webhook.
- When file-webhook capacity is exhausted, metadata heartbeat and checkpoints remain valid; the team is not blocked.
- Disconnect removes the team's active authorization reference and webhook. Historical snapshots remain under the approved evidence-retention policy.

## 5. Google and Better Auth setup

Create separate Google OAuth configuration for development, staging, and production.

For each environment:

- register the exact web callback proxied to Better Auth;
- register iOS bundle and Android package/signing data required by the chosen Google flow;
- register the Expo app scheme as a Better Auth trusted origin;
- keep development wildcard origins out of staging/production;
- configure the supported client ID list;
- verify consent-screen status and test-user limits;
- confirm `sub`, verified email, and `hd` in a server callback test.

Better Auth configuration:

- email/password disabled;
- Google enabled;
- seven-day session expiry and twelve-hour update age;
- secure cookies;
- account linking policy tested with two Google accounts;
- session and role revocation test;
- auth-intent nonce consumed once.

The VIT domain list comes from event configuration after VIT IT confirms it.

## 6. Expo notifications

### Registration

At device check:

- request permission;
- obtain Expo push token;
- upsert token against installation ID;
- remove the same token from an old/replaced device;
- send a test notification in staging/training;
- report permission/token failure to clock-in.

### Send

An accepted page mutation creates the page and a `push_send` job. The action sends a payload containing page ID, event ID, route, and generic alert text.

Do not include team project text, score, phone number, or private reason.

### Ticket and receipt

- Store Expo ticket ID.
- Fetch provider receipt after the documented delay.
- Disable tokens with terminal device errors.
- Retry transient provider/network errors with a cap.
- Keep reviewer acknowledgement separate from provider delivery.

The 90-second page deadline is based on the page record, not the push ticket.

## 7. VIT ID scanner and QR release

Reading a compatible VIT ID card is native application functionality, not a web integration. The participant website never promises browser NFC.

The Expo app includes:

- `expo-camera` for external-badge and dynamic portal QR;
- `react-native-nfc-manager` behind an app-owned VIT-card adapter;
- a config plugin and required Android/iOS NFC declarations;
- a custom development/preview/production build, never Expo Go;
- secure auth/device registration and an encrypted pending-operation queue.

The event qualifies one primary Android scanner model, one spare model, and representative current VIT cards from every available campus/batch profile. The test covers first read, repeat read, stable identifier normalisation, app resume, screen lock, camera/NFC switching, duplicate taps, card removal, low battery, connection loss, and 30 minutes of continuous station operation. A card profile that does not pass uses QR. iOS remains a QR-capable reviewer/scanner client; iOS NFC is enabled only after the exact production build and VIT card profiles pass the same throughput and recovery test.

VIT card enrolment is a protected staffed workflow:

1. require the participant’s active VIT event membership and a fresh Google-backed session;
2. compare the visible card name, photo, and registration number with the participant record without capturing a card image;
3. read the same card twice on the provisioned phone;
4. send the phone-read identifier only to the protected backend command;
5. derive an event-scoped keyed fingerprint server-side, discard the raw identifier, and bind the fingerprint to that event membership;
6. read once more and show the resolved participant to the operator;
7. suspend an incorrect or replaced binding through a lead-authorised, reasoned rebind rather than editing history.

The VIT card is presentation evidence, not the account. Google identity and the event membership remain authoritative. The app never writes to the VIT card, never stores or logs its raw identifier, and never stores a card photo. One active fingerprint can bind to only one event membership.

An external participant may receive an ordinary event badge with a random opaque QR. Convex stores only its hash and credential version. The printed value contains no name, registration number, team, email, or session. Revocation and replacement are protected station commands. Every participant can use a short-lived portal QR as the configured fallback; VIT students do not receive a replacement NFC tag.

Production release inventory records:

- scanner installation, model, OS, app/runtime build, camera/NFC capability, station, charger, and spare owner;
- tested VIT campus/card-profile label, phone/card compatibility result, repeated-read count, identifier-normalisation version, and approved fallback;
- external-badge print batch, read-back result, and issued/revoked/replaced counts;
- session station layout, direction, expected throughput, backup network, and operator shift;
- last successful online scan, pending queue age, and device heartbeat.

An attendance-native dependency or permission change requires a new signed build and full scanner rehearsal. A compatible JavaScript update cannot add NFC support to an installed runtime that lacks the native module.

## 8. Private artifact and export bucket

The selected baseline is a private AWS S3 bucket in Mumbai (`ap-south-1`) after data-policy approval. It holds immutable round exports, downloaded backups, compressed Figma checkpoints, captured Figma previews, and any short-lived GitHub blob cache. Live counters and searchable metadata stay in Convex.

Configuration:

- public access blocked;
- bucket versioning on;
- server-side encryption with a dedicated KMS key;
- event-specific prefixes split by export, backup, and team integration;
- deployment credential can write/list only the active event prefixes;
- audit/backup readers use separate restricted IAM identities;
- lifecycle expiry matches approved retention;
- object checksum and application manifest retained.

Integration artifact layout:

```text
events/{eventId}/teams/{teamId}/integrations/{provider}/{integrationId}/{snapshotId}/
  manifest.json
  figma-file.json.gz
  previews/{nodeId}.png
  temporary-github-blobs/{blobSha}
```

Only files present for that provider are written. Figma JSON and previews follow the approved evidence-retention period. GitHub blob cache uses a short lifecycle tied to the review window. A reviewer receives a short-lived signed object URL only after the backend verifies the assigned review and exact snapshot.

Round export layout:

```text
events/{eventId}/rounds/{roundId}/{timestamp}/
  manifest.json
  teams.csv
  reviews.csv
  scorecards.csv
  audit.jsonl
  manual-records.jsonl
  checksum.sha256
```

Convex backup ZIP files use a separate `backups/` prefix. Restore access is not held by the running application.

If VIT policy requires another provider/region, replace this decision before production registration data exists.

## 9. Environment matrix

| Item | Development | Staging | Production |
| --- | --- | --- | --- |
| Web | local/preview | protected staging domain | event domain |
| Convex | developer deployment | rehearsal deployment | production deployment |
| Better Auth | dev secret/clients | staging secret/clients | production secret/clients |
| OpenAI | dev project/key and synthetic input | staging project/key and intake evals | production project/key and published model config |
| Event app | dev build/scheme with synthetic card fixtures | preview build/channel, representative VIT cards, and rehearsal scanners | production build/channel and provisioned scanner/reviewer fleet |
| GitHub | dev App | staging App/test repos | production App/team repos |
| Figma | dev OAuth/webhook/test files | staging OAuth/webhook/test files | approved production OAuth App and webhook endpoint |
| Push | test devices | reviewer training devices | registered event devices |
| S3 | local/test bucket | staging integration/export prefixes | production integration/export prefixes |
| Sentry | development | staging | production |

No callback URL, provider key, auth secret, user record, or push token is shared across staging and production.

## 10. CI

Pull requests run:

1. dependency lockfile check;
2. formatting, lint, and TypeScript;
3. domain/unit tests;
4. Convex schema/function tests;
5. Next.js build;
6. Expo export/config validation;
7. Playwright against an isolated seeded deployment;
8. OpenAI contract/fallback fixtures and provider webhook fixtures;
9. secret scan.

Main-branch release candidates also run:

- signed Expo staging build when native inputs changed;
- Maestro smoke suite on at least Android and iOS plus physical-device VIT-card/QR smoke when attendance native inputs changed;
- database migration/backfill check;
- load smoke test;
- staging auth/integration health checks.

CI logs must not print environment values, cookies, webhook bodies, or provider responses containing tokens.

## 11. Production release

### Before event freeze

1. Deploy additive Convex schema/functions to staging.
2. Run any backfill and verify counts.
3. Deploy Vercel staging and event-app preview build/update.
4. Run auth, deterministic/model intake, VIT-card/QR attendance, one-review, integration, push, export, and incident smoke tests.
5. Publish the production event-app build and install it on reviewer and scanner devices.
6. Set the minimum build only after installation/training is complete.

### Production promotion

1. Take a production backup and record current release IDs.
2. Deploy backward-compatible Convex functions.
3. Run protected production smoke queries with synthetic/admin test records.
4. Create a staged Vercel production deployment and run route/auth checks.
5. Promote the tested Vercel deployment.
6. Publish a compatible EAS update only if needed and test a small device group first.
7. Verify one synthetic OpenAI interpretation/fallback, one enrolled VIT-card and one QR attendance transition, GitHub/Figma callbacks, one test push, export bucket write, Sentry release, and dashboard release IDs.
8. Record the release in event configuration.

Do not change native dependencies, auth callback shape, rubric calculation, or destructive schema during a live round.

## 12. Compatibility and migrations

- Schema changes are additive through the event.
- New required fields start optional, receive a backfill, then become required in code after verification.
- A backend function supports the installed reviewer runtime until the minimum-build change is complete.
- Every EAS Update has a runtime version compatible with the installed native build.
- Changing a native dependency creates a new runtime/build.
- Event/rubric/panel configuration is versioned; a code deploy does not rewrite an active round’s configuration.
- Attendance plans, sessions, expectation snapshots, station assignments, and credential versions are preserved across deploys; a code change cannot reinterpret an open session without a compatible published policy/version.
- Track catalogs, intake shells, question policies, fallback prompts, model instructions, and output schemas are immutable versions; active sessions do not silently move between them.

## 13. Rollback

### Web

Move the production domain back to the last verified Vercel deployment. Confirm its environment and backend compatibility.

### Reviewer update

Roll back to the previous EAS Update on the same runtime. A native-runtime problem requires the prepared previous signed build or spare devices.

### Attendance scanner

Pause or redirect affected stations, retain pending operations, and move to the prepared previous signed build/spare fleet. Never downgrade a credential version or re-enable a suspended VIT binding or revoked external badge to match an old client. Reconcile pending scans only after the restored build passes one online VIT-card and QR test against the current station configuration.

### Convex functions

Redeploy the last compatible source commit. Additive schema changes stay in place. Do not restore the database for an ordinary code defect.

### Intake model/config

Point new sessions to the last published compatible model configuration. Sessions already pinned to a valid older version continue. If a configuration is unsafe, disable its model path so every affected session uses its already-published deterministic fallback; do not rewrite participant answers.

### Data

Use protected repair mutations for a small known error. Use backup restore only for a confirmed broad data incident under the rehearsed destructive-restore procedure.

### Auth/provider configuration

Restore the recorded previous secret/config version only if it is still secure. Never roll back to a compromised credential.

Every rollback records owner, reason, affected release IDs, start/end time, and verification result.

## 14. Secret rotation

Before launch, rehearse rotation for:

- Better Auth secret;
- Google client secret;
- OpenAI API key;
- GitHub App private key and webhook secret;
- Figma client secret and file-webhook passcodes;
- token-encryption key;
- attendance-key wrapping key;
- Expo server credential;
- S3 application credential;
- Sentry auth token.

Token-encryption key rotation keeps the previous decrypt key until all active Figma authorizations are re-encrypted. Attendance-key wrapping rotation re-encrypts each event lookup key and verifies the authenticated ciphertext and key-check digest without changing a card fingerprint. A compromised event lookup key is different: pause VIT-card acceptance, create a new event key set, and require staffed card re-enrolment while QR remains available. GitHub webhook-secret rotation may require an overlap or coordinated provider update. Figma passcode rotation updates each active webhook and verifies its new `PING` before discarding the old encrypted value.

## 15. Release acceptance

- Production auth callbacks accept only production origins/schemes.
- The first intake frame is **Hello.**, followed by **What is your project about?**, with one text box and no form, chat, or PPT UI.
- Every introduction asks three to five follow-ups: generated questions on the normal path and published fallbacks when model work is disabled or rejected. Later event-phase/track paths obey their smaller published bounds and the same wording policy.
- OpenAI requests set `store: false`, expose no tools, exclude identity/judging fields, and accept only the strict versioned output schema.
- A timeout, refusal, invalid output, quota error, or disabled model still lets a team finish and submit; a late result cannot replace the visible question.
- A generated question is short, single-purpose, easy to answer, source/configuration-linked, validated before display, and never treated as a participant answer.
- Event phase is server-assigned; suggested track values and the freshness attestation remain unconfirmed until the team acts, and every generated brief field cites source answers.
- GitHub App permission screen contains no write/admin permission.
- A team can add repositories from different App installations and give each a required kind, purpose, branch/root, and order.
- The portal verifies `code2create-7-0` on every active repository; a missing topic does not cause an Administration permission request.
- Invalid, repeated, or out-of-order GitHub webhook deliveries do not double-count activity.
- Per-repository and combined metrics agree, duplicate fork commits are marked, and an inaccessible repository makes the combined view incomplete.
- A reviewer can switch through every repository in the fixed checkpoint set and browse it at the exact captured SHA without exposing an installation token.
- Adding, archiving, reordering, reclassifying, or refreshing a repository cannot change an existing review checkpoint set.
- Figma OAuth requests the documented read scopes and creates a file webhook only when access and plan capacity allow it.
- A captured Figma checkpoint includes the full file tree, derived statistics, and frame previews; the raw document does not enter a Convex document.
- Provider rate limits leave an explicit metadata/content age and completeness state instead of blocking a review.
- Two team members see one shared integration, and any current lead can replace a revoked Figma authorizer.
- Push ticket, receipt, reviewer acknowledgement, expiry, and fallback remain distinct.
- Representative VIT cards and QR scan successfully in the signed production build on the provisioned fleet; an incompatible card has a complete QR path, and the web portal makes no Web NFC promise.
- A raw VIT card identifier is discarded after event-scoped fingerprinting and never becomes participant identity. A suspended prior binding or replaced external badge is rejected online, while historical events remain traceable to the old credential reference.
- A repeated/simultaneous mixed-method scan creates one accepted transition; a connection loss remains pending and replays idempotently.
- Two consecutive attendance sessions, temporary exits/returns, a session extension, and an emergency roll call update every live projection without rewriting presence events.
- A compatible web/backend/mobile release survives rollback rehearsal.
- Round export and one Figma artifact reach the private bucket with matching checksums and no provider credential.
- A production bundle/secret scan finds no private credential.

## References

- [OpenAI Responses API](https://developers.openai.com/api/reference/resources/responses)
- [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [OpenAI evaluation best practices](https://developers.openai.com/api/docs/guides/evaluation-best-practices)
- [OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data)
- [Expo development builds](https://docs.expo.dev/develop/development-builds/introduction/)
- [Expo custom native code](https://docs.expo.dev/workflow/customizing/)
- [React Native NFC Manager](https://github.com/revtel/react-native-nfc-manager)
- [Android NFC overview](https://developer.android.com/develop/connectivity/nfc)
- [Apple Core NFC](https://developer.apple.com/documentation/CoreNFC)
- [GitHub App permissions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app)
- [GitHub installation access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)
- [GitHub webhook signature validation](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)
- [GitHub repository topics](https://docs.github.com/en/rest/repos/repos#get-all-repository-topics)
- [GitHub push payload](https://docs.github.com/en/webhooks/webhook-events-and-payloads#push)
- [GitHub commits and comparisons](https://docs.github.com/en/rest/commits/commits)
- [GitHub repository statistics limits](https://docs.github.com/en/rest/metrics/statistics)
- [GitHub Git Trees API](https://docs.github.com/en/rest/git/trees)
- [Figma OAuth scopes](https://developers.figma.com/docs/rest-api/scopes/)
- [Figma file, node, metadata, and image endpoints](https://developers.figma.com/docs/rest-api/file-endpoints/)
- [Figma version history](https://developers.figma.com/docs/rest-api/version-history-endpoints/)
- [Figma comments](https://developers.figma.com/docs/rest-api/comments-endpoints/)
- [Figma webhook events](https://developers.figma.com/docs/rest-api/webhooks-events/)
- [Figma webhook limits and permissions](https://developers.figma.com/docs/rest-api/webhooks/)
- [Figma webhook security](https://developers.figma.com/docs/rest-api/webhooks-security/)
- [Figma rate limits](https://developers.figma.com/docs/rest-api/rate-limits/)
- [Expo notification tickets and receipts](https://docs.expo.dev/push-notifications/sending-notifications/)
- [Expo runtime versions](https://docs.expo.dev/eas-update/runtime-versions/)
- [Vercel deployment promotion and rollback](https://vercel.com/docs/deployments/promoting-a-deployment)

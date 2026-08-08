# Integrations and release

## 1. Integration rule

The connected GitHub repositories and Figma file belong to the Code2Create team record. They do not belong to the member who happens to install the GitHub App or finish Figma OAuth.

- A team lead adds, classifies, reorders, replaces, or disconnects a resource.
- Every active team member can see the same repository set, connection health, progress facts, and captured checkpoints.
- An assigned reviewer can see the immutable checkpoint attached to that review.
- `integration.read` exposes team-scoped connection health and cached provider facts; the separate event-scoped `operations.health.read` exposes aggregate counts without resource detail.
- Provider credentials never enter a participant, reviewer, or operations client.

GitHub and Figma record evidence. They do not calculate effort, originality, technical quality, or score. Every fact is labeled with its provider time, capture time, completeness, and previous checkpoint. A missing, late, rate-limited, or stale integration stays visible and the review continues with live/manual evidence.

Each GitHub repository and Figma file can be active for only one team in the same event. `integration.shared_resource.override` must cover every affected team/resource and include a reason; the exception appears to every affected reviewer.

OpenAI, GitHub, Figma, Expo, S3, and Google calls happen outside Convex mutations. Every environment has separate credentials, and no external system owns authoritative event state.

## 2. OpenAI novelty, intake, and admission

Create a separate OpenAI API project and restricted service key for development, staging, and production. The key lives only in the corresponding Convex environment.

### Live novelty embeddings

The participant novelty signal uses `POST /v1/embeddings` with `text-embedding-3-small`, `encoding_format: float`, and no `dimensions` override. The contract is exactly one finite 1,536-value vector per input. Corpus import may send one bounded ordered batch; participant preview sends one normalized idea. The endpoint returns one JSON result rather than a partial-vector stream, so the browser debounces requests and displays only the newest complete response.

The production corpus contains 5–200 privacy-reviewed past-project summaries, broad participant-safe theme labels, and supportive reflection questions. Operations imports a complete draft under `configuration.novelty.entries.write`; every vector must validate before one transaction replaces the set. A separate fresh-authenticated publication moves the event pointer. Development uses synthetic entries, staging uses an approved non-production corpus, and production uses the reviewed event corpus. No environment shares a key or corpus ID.

Before participant provider work, the backend rejects input containing common contact, registration-number, URL-credential, or secret patterns. It stores only the input fingerprint, character count, team/person/corpus references, terminal category, and bounded result metadata. The participant sees the score/band, corpus label/count, and approved nearest theme/reflection prompt, never the nearest summary, source key, similarity, vector, fingerprint, or provider request ID. Provider failure returns unavailable and cannot block the intake route.

Corpus policy release tests exact native width, complete ordered batches, duplicate/unsafe entries, similarity boundaries, score bands, exact permissions, atomic replacement, stale publication, and a participant request racing newer text, submission, and corpus publication. The release record names the corpus version/checksum, model, fixed width, thresholds, entry count, privacy approval, and aggregate provider latency/error results.

### Intake interpretation

The Convex action uses the Responses API as a single-turn extraction request:

- `store: false`;
- background mode off;
- no built-in, function, web, file, or MCP tools;
- an approved model ID or snapshot from the pinned assisted `intakePolicyVersion`;
- bounded input and output;
- strict Structured Outputs through `text.format` and the versioned `c2c_intake_interpretation` JSON Schema.

The request includes only:

- the redacted active question/answer history needed to avoid repetition;
- opaque source answer-version IDs;
- the published question-purpose policy;
- published core-track definitions from the draft's pinned catalog;
- prior generated-question wording, the target ordinal, question length limit, and reviewed common-idea patterns.

It excludes application-owned names, email, phone, registration number, Google claims, team invitations, auth/session data, admission state, GitHub/Figma credentials, reviewer context, and all score data. Before the request, a versioned deterministic filter replaces common contact, registration-number, URL-credential, and secret-token patterns inside participant free text. The original answer remains only in the project record; redacted request text is not copied into job or error logs.

The output can contain at most one published core-track recommendation, covered purpose keys, an optional abstract common-idea-pattern key, and one free-text `nextQuestion`. After schema parsing, application code rejects these conditions:

- unknown or unpublished keys;
- stale answer references;
- a question after ordinal two;
- a disallowed purpose;
- more than one question mark;
- normalized duplicate wording;
- blocked personal or credential patterns;
- prohibited wording; or
- text beyond the pinned limit.

The result cannot call a Convex function. An internal mutation writes a current valid result as an `intakeInterpretation`. It writes the question as a separate immutable `intakeGeneratedQuestion`. Both records use the exact input and policy versions. The full track list appears immediately after the opening save and never waits for this result.

### Prompt-injection and failure handling

The system instruction states that participant text is untrusted project material and cannot modify the schema, question policy, allowed IDs, or product rules. Delimiter text alone is not treated as security. The actual boundary is no tools, a closed output schema, server-side key and question-text validation, immutable version checks, and no authoritative write path.

Each answer-set, pinned-policy, pinned-catalog, and ordinal tuple has one deduplicated interpretation. The intake Workpool has independent concurrency. It disables Workpool retry for the provider action, and the OpenAI client uses the pinned timeout with `maxRetries: 0`.

The pinned intake policy supplies one deterministic fallback for each possible ordinal. Timeout, refusal, incomplete output, invalid schema, question-policy rejection, rate limit, or service outage records a non-sensitive failure category and writes that fallback. Raw answers and submission remain available.

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
- questions that should be answerable immediately in one to three sentences and cases where the model should stop after the first or second follow-up;
- common-idea cases that should invite useful differentiation/follow-through without comparison, discouragement, or a novelty verdict;
- sensitive personal data pasted into a project answer;
- redaction fixtures for email, phone, registration number, URL credentials, and common secret formats;
- refusal, truncation, invalid output, timeout, and late-result fixtures.

Assertions cover schema validity, source attribution, published track/pattern IDs, question relevance, easy-answer rate, length, and one-question form. They also cover duplicate/prohibited-topic/PII rates, the one-to-two introduction bound, no invented evidence, no authoritative selection, no negative effect from choosing another track, and deterministic fallback. Model or prompt changes publish a new immutable version. They do not rewrite active sessions.

The release suite uses a held-out set separate from prompt examples. Human reviewers label each question against short binary criteria: relevant to the team's text, answerable now without research, one idea, plain language, non-judgmental, and non-repetitive. Candidate and current configurations are compared on the same cases. The publication record stores thresholds and aggregate results. Opted-in production feedback adds new edge cases to a later suite; participant text does not enter an evaluation dataset by default.

### Data controls

Production sends `store: false` and does not use OpenAI Conversations or background responses. This avoids the Responses API's ordinary stored application state, but it is not the same as Zero Data Retention. By default, API abuse-monitoring logs may contain prompts and responses for up to 30 days. Before registration opens, the event privacy owner must approve the disclosed use and effective retention controls, and decide whether to seek Modified Abuse Monitoring or Zero Data Retention.

### Admission recommendation contract

Before applications open, operations publishes the complete human rubric together with either one exact model configuration or explicit human-only mode. The pair has one lifecycle: matching draft, validation, publication, supersession, and checksum checks. Publication also creates the policy's empty overall capacity bucket and moves both event pointers in the same Convex mutation. The first application closes later drafts and publication; a submission/publication race resolves to one policy through Convex transaction conflicts.

When enabled, admission analysis uses that policy's own model ID, prompt/JSON Schema/evaluation-suite release labels, deduplication key, and `admission_ai` Workpool. It runs only after final submission has atomically locked the project version, active member set, core track, selected sponsor-track set, and admission-policy ID. There is no model fallback to a different policy release.

The request includes the redacted submitted initial idea and follow-up answers. It includes the participant-visible follow-up questions, cumulative organizer-requested information questions and locked-lead answers, deterministic experience-band key, and published year-adjusted admission criteria. Requested-information entries receive stable source references in request/answer order. Every criterion can therefore cite the exact participant evidence. The request excludes names, contact/registration data, institution prestige signals, core- and sponsor-track choices, raw eligibility evidence, and freshness metadata. It also excludes the intake track recommendation or whether the team followed it. It excludes human review/decision state, capacity, attendance, GitHub/Figma activity, judging rubrics, scores, and rankings.

The strict output contains:

- `recommendation: accept | waitlist | decline | needs_information`;
- `criterionAssessments[]` with `meets | partly_meets | not_yet_clear` and application source references;
- concise strengths, concerns, and no more than two suggested information questions;
- confidence/limitations and the exact policy/schema version echoed from allowed IDs.

Application validation rejects numeric pseudo-scores, judging/winner language, unsupported facts, institution/prestige reasoning, track-recommendation mismatch, unknown criteria/sources, overlong explanations, stale versions, and any attempt to encode an action. Valid output is an immutable advisory record. The only decision command requires a human permission, explicit Accept/Waitlist/Decline/Needs information choice, and an audited `used | cleared | overridden | stale | unavailable` disposition. Refusal, timeout, invalid output, or a disabled provider leaves the human workflow fully usable.

## 3. Durable intelligence Worker

The separate `apps/intelligence` package is scaffolded with Flue for the Cloudflare target and built through Vite. It uses the Cloudflare Workers AI binding, so the Worker holds no third-party model API key. The initial agent pins `cloudflare/@cf/moonshotai/kimi-k2.6` and `operations-brief-v1` in source. Production still requires the approved model, evaluation fixtures, budget, and retention policy from O-037; a model or instruction change increments the agent version and passes staging before deployment.

Convex dispatches only `POST /v1/operations-briefs`. The body is the protocol version, brief ID, SHA-256 source checksum, and one frozen `OperationsHealthSnapshot`. The Worker has no general agent route. It verifies `content-type`, a 64 KiB body limit, strict closed Valibot schema, millisecond timestamp within five minutes, and HMAC-SHA-256 signature under the ingress-specific context before Flue sees the request.

The brief ID becomes a create-only Durable Object identity. A successful dispatch receipt reports its submission ID/time; the same ID later reports `already_exists`. This makes a Workpool retry safe without an application-level model-submission race. The agent's only tool accepts the strict headline/summary/priority schema and posts the result to the exact configured Convex callback. If the model ends without the tool, Flue sends one reminder; a second non-publication returns a bounded failure. Agent durability is limited to three attempts and eight minutes, while Convex owns the outer ten-minute deadline.

The callback has its own 24 KiB limit, strict Zod schema, five-minute window, HMAC secret, and signature context. The two secrets are unrelated and environment-specific. Convex validates the frozen checksum and evidence constraints before accepting the first terminal settlement. Neither side logs the body or signature. Cloudflare tracing is enabled with content capture disabled.

Staging and production require these paired values:

- Convex: `INTELLIGENCE_WORKER_URL`, `INTELLIGENCE_INGRESS_SECRET`, and `INTELLIGENCE_CALLBACK_SECRET`;
- Worker: `CONVEX_INTELLIGENCE_CALLBACK_URL`, `INTELLIGENCE_INGRESS_SECRET`, and `INTELLIGENCE_CALLBACK_SECRET`;
- Worker binding: `AI`.

The callback URL is `<CONVEX_SITE_URL>/intelligence/operations-briefs/callback`. The Worker URL must be HTTPS outside local development. Each secret is at least 32 random characters and is entered through Convex/Wrangler secret stores without shell-history or CI-log output. Development, staging, and production never share a URL or secret.

The proactive operations scheduler runs inside Convex and adds no Worker route, secret, or tool. Its published policy and scheduler state decide whether a frozen health signal may create the same brief job. The Worker cannot tell whether a policy is enabled, advance its budget, or produce a second job for a signal.

Future intelligence jobs follow the same rule: define one redacted versioned input, one closed output, one job identity, one retention class, and no broad service credential. If an output proposes an event action, the proposal returns to the normal application confirmation; the Worker does not receive that command.

## 4. GitHub App

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

The reorder command accepts the complete current non-archived ID/version sequence, not one unversioned row move. It verifies the full set and every version in the same Convex transaction that compacts the order. A concurrent add, archive, refresh, or reorder therefore wins wholly or makes the stale command reload; two browser tabs cannot merge an older partial order into the live set.

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
10. The lead repeats the flow for every submitted repository and can start another App installation flow when the next repository belongs to a different account or organization.

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
5. resolves the repository binding, records the small provider event, and advances that repository plus the one current team summary projection;
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

The current team summary is one indexed row materialized from active repository bindings and their metric rows. Connection, add, archive, refresh, sync start/success/failure, and accepted webhook mutations rebuild it transactionally. It contains health, installation/repository and per-kind counts, topic coverage, push/change/language totals, complete/expected repositories, last activity, and observed commit identity coverage. Per-repository values stay beside the combined view.

The comparison request asks for one page of at most 100 commits. A commit SHA observed in two connected forks remains visible in both repository histories but counts once in the team summary, which also records the overlap. When GitHub's reported total exceeds the returned identities, the observed unique count is a lower bound and `commitIdentityComplete` is false. A project-root binding also omits commit identities because GitHub's comparison commit list is repository-wide while its file totals can be filtered to the declared root. Missing, inaccessible, root-filtered, or truncated evidence makes the combined result partial; it never becomes an invented exact total.

At each checkpoint, the backend captures every active repository and Figma file independently, then creates one immutable checkpoint set containing the ordered repository and Figma binding/snapshot pairs. A missing or inaccessible resource remains in the set with its failure state. Review start stores the checkpoint-set ID, so adding, removing, reordering, archiving, or refreshing a provider resource later cannot change the evidence already shown to reviewers.

GitHub's repository-statistics endpoints are periodic enrichment only. They can return `202` while GitHub computes a cache, reset when the default-branch SHA changes, and do not support repositories with 10,000 or more commits. Live cards therefore come from signed pushes plus commit/compare reconciliation, not the cached statistics endpoints. A paginated Compare response returns at most 100 commits per page and exposes changed files only on the first page, capped at 300, so the current bounded reconciliation records both metric and commit-identity completeness.

Counts are context. Squashes, generated files, rebases, pair programming, and Git author configuration make them unreliable as a score or as proof of individual contribution.

### Failure and revocation

- Installation removal marks every affected repository binding `revoked` and stops its jobs.
- Repository-access removal marks only that binding `inaccessible`; the other team repositories continue updating.
- Rename or transfer resolves by repository ID on reconciliation.
- A force push records the new head and a discontinuity; it never silently rewrites an earlier snapshot.
- A deleted tracked branch requires the team to choose another branch and creates a new baseline relationship.
- Rate-limit responses pause that installation's Workpool lane until reset; live clients keep the last verified data and its age.
- Removing or replacing a repository before freeze changes the active set and preserves earlier binding versions, snapshots, and checkpoint sets.

## 5. Figma OAuth and full design evidence

### Scopes

Request only:

- `file_content:read`;
- `file_versions:read`;
- `file_comments:read`;
- `webhooks:write`.

The file-content scope is required because reviewers and teams need the document tree, components, styles, prototype structure, and rendered frames, not a metadata card. Comment read access supplies open/resolved collaboration context. The App never writes comments or file content.

Do not request `projects:read`, organization scopes, variables, libraries, or write scopes in the baseline. A later event may add `file_dev_resources:read` or `file_variables:read` only after a separate feature, plan check, consent text, and review. Variables API access is not available on every Figma plan.

The portal accepts a Figma file URL instead of listing a person's projects. The backend parses the file key and reads the file through `GET /v1/files/:key`; it does not request a second metadata scope for a separate preflight call.

### Credential grant versus team ownership

Figma OAuth is granted by a person, so the encrypted token record is keyed by the Figma user ID, not copied once per team or event. The selected files, snapshots, metrics, and review visibility remain owned by `eventId + teamId` through explicit credential-connection and file-binding rows.

One Figma authorization may support more than one team connection if that Figma user can access those files. Refreshing it updates one credential record, avoiding the race caused by Figma maintaining one current access token per App and user. If the authorizer leaves the Code2Create team or revokes access, the team data remains and any current team lead can replace the authorization.

### Connection flow

1. A team member selects **Connect Figma**.
2. The backend creates a one-use OAuth intent bound to event, team, person, PKCE verifier, and exact callback.
3. The browser opens Figma OAuth with state and an S256 PKCE challenge.
4. The callback validates state and exchanges the 30-second authorization code at `/v1/oauth/token`.
5. The backend encrypts the access and refresh tokens and stores `user_id_string` as a string.
6. The member can paste one or more file URLs up to the event's published team cap.
7. For each file, the backend checks metadata, access role, file/main-file key, link access, current version, and whether that file is already used by another event team.
8. A holder of `integration.figma.manage` for the exact team confirms the file.
9. The backend commits the full content, version history, comments, selected render candidates, and raw-artifact manifest as one baseline snapshot.
10. A separate leased render job asks Figma for the selected nodes at that exact snapshot version and copies successful PNGs to private storage. Render failure does not discard the raw baseline.
11. It attempts one file-context `FILE_UPDATE` webhook when the authorizer has **Can edit** access and the plan has capacity.

The public production OAuth App must complete Figma review before participant onboarding. Access tokens are refreshed before expiry through `/v1/oauth/token`; the legacy refresh endpoint is not used.

### Provider observation and application realtime

Convex publishes a received provider event or completed metadata check to every authorized client immediately. That does not make Figma itself instant:

- `FILE_UPDATE` can arrive only after up to 30 minutes of editing inactivity;
- a file webhook requires Can edit access;
- Figma limits file webhooks by context and plan;
- full-file and image calls are Tier 1 and can be as low as six requests per month for View or Collab seats.

The production design combines three signals:

1. A file-context `FILE_UPDATE` webhook when available. Its passcode is validated before the event is accepted.
2. A lightweight Tier 3 `GET /v1/files/:key/meta` heartbeat using `file_metadata:read`. During the live event it targets 90–120 seconds when the webhook is active and 60–90 seconds when the webhook is unavailable. Registration checks run roughly every 15–17 minutes; draft and completed events run roughly every six hours.
3. Explicit full checkpoints at connection, before each review window, review start when stale and allowed, round close, and participant refresh.

A Convex cron dispatches a bounded page every 15 seconds and the integration workpool keeps at most six provider actions in flight. Stable per-file jitter avoids a single event-wide burst. Each metadata request has a 30-second network timeout and a 90-second lease; a dispatched job that never starts becomes due again after five minutes. Completion requires the exact lease. Provider last-touched time and server observation time reject an out-of-order response instead of allowing an older result to overwrite a newer full capture.

A metadata version change marks the team view `content_dirty` immediately and coalesces one full-content job only when Figma has identified the authorizer as a high-rate-limit seat. Low or still-unknown grants reserve Tier 1 calls for explicit and review checkpoints. This matters because file metadata is Tier 3, while a full file is Tier 1 and View or Collab seats can be limited to six full-file requests per month. A `429` stores `Retry-After`, `X-Figma-Plan-Tier`, and `X-Figma-Rate-Limit-Type`. Metadata and full-capture retry gates are separate because Figma budgets requests by endpoint tier; neither path retries its affected tier before the provider time. The plan and low/high classification remain available after recovery so later work does not forget what the provider reported.

The participant portal and operations integration view show metadata checked and full content captured separately, plus dirty, error, and rate-limit state. Event health raises a stale-metadata signal after four minutes while live and after 45 minutes during registration. “Live” never hides a stale full snapshot.

### Full snapshots, previews, and statistics

`GET /v1/files/:key` returns the complete node tree when no `depth` or `ids` filter is supplied. The raw response can exceed Convex's one-megabyte document limit, so the action compresses it and writes an immutable private S3 object. Convex stores only the manifest, hashes, derived facts, and authorized preview references.

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

The full-capture action also reads Figma's [file version history](https://developers.figma.com/docs/rest-api/version-history-endpoints/) and [file comments](https://developers.figma.com/docs/rest-api/comments-endpoints/) with their separate read scopes. Version history follows only same-origin pagination URLs for this exact file, stops after 100 pages, deduplicates provider IDs, sorts newest first, and retains at most 200 facts. Comment capture deduplicates and retains at most 400 facts. Labels are capped at 500 characters, handles at 256, and descriptions/messages at 4,000 with explicit truncation flags. Each manifest records observed count, retained count, and completeness.

Version and comment facts commit atomically with the file snapshot, metrics, raw-artifact manifest, preview set, and frame candidates. Figma versions are historical provider records. The comments endpoint is not version-addressable, so a captured comment means it was observed when this snapshot ran; it is not retroactively attributed to the file version's original save time.

The image endpoint renders one batch against the snapshot's exact `version` value; opening a review never renders the current file on demand. The current technical bound selects at most 48 visible top-level frames, components, component sets, sections, or instances per file, distributed round-robin across the first 100 pages. A page render is used when a page has no frame-like top-level node. Selection and truncation are recorded with the snapshot.

The worker requests half-scale PNGs, downloads at most four concurrently, accepts no file over 8 MiB or preview set over 64 MiB, validates the PNG dimensions, and writes each successful render under a content-addressed private S3 key. Figma's temporary URL is never stored or returned to a client. A leased job has an expiry recovery path, honors `Retry-After`, and reaches `ready`, `partial`, `rate_limited`, or `failed` without changing the raw snapshot. Individual null, oversized, invalid, download-failed, or upload-failed renders remain visible as unavailable frame facts.

An assigned reviewer loads the normalized page/frame index through the fixed review checkpoint and opens one successful preview through a fresh one-minute signed URL. The request rechecks the review assignment, exact `review.evidence.read` grant, checkpoint set, file binding, snapshot, preview set, frame fact, provider version, and private manifest. The same fixed-checkpoint boundary can read the gzip artifact server-side, verify both byte counts, SHA-256, and its internal provider version, then return one 60-child layer page with bounded layout, style, component, text, flow, and interaction facts. It can also return the stored version/comment facts without a live provider call.

For Review 2 and later, the current evidence set stores the latest lower-round-sequence evidence-set ID for that team. The reviewer comparison finds the same Figma binding in those two sets and joins their stored frame facts by node ID. It never uses the file snapshot's adjacent-provider-snapshot link, which may point to an incidental webhook or manual refresh rather than the previous judging context. Same semantic hash is unchanged; a different hash is changed. A node on only one side is added or removed only when the opposite selection is complete, otherwise it is uncertain. Side-by-side images are signed for one minute from the exact stored facts; the comparison makes no Figma request.

These paths do not spend another rate-limited Figma request. Bucket names, object keys, Figma credentials, temporary provider URLs, and unbounded raw nodes never enter the ordinary reviewer response; an explicitly requested protected raw download remains available.

Figma does not expose keystrokes, edit duration, every autosave, or reliable per-person contribution. Version/comment handles and changed-node counts are labeled as observed activity, not authorship or effort.

### Current team projection

One `figmaTeamMetrics` row per event/team aggregates active authorisations/files, complete/incomplete and dirty files, webhook/rate-limit state, preview readiness, pages, frames, components, styles, nodes, prototype interactions, comments/open threads, named versions, and freshness. The owning transaction rebuilds it after every accepted connection, file, metadata, full-content, preview, and webhook transition. Participant cards and the collapsed operations board subscribe to this row. The operations surface loads current file/snapshot/preview detail only for the one team an operator expands, and raw checkpoint access still requires the separate exact-scope artifact grant.

### Failure, revocation, and webhook limits

- Wrong passcode, unknown webhook/file, or duplicate `{webhook_id, event_type, file_key, timestamp}` is rejected or ignored.
- `PING` proves endpoint setup but does not create a project snapshot.
- Expired or invalid OAuth credentials mark every dependent team binding `reauth_required`.
- File permission loss marks only that file binding `inaccessible`.
- A paused/error webhook falls back to metadata heartbeat and appears in integration diagnostics.
- A metadata-scope or authorization failure leaves the already captured evidence intact and asks for reauthorization; a confirmed missing file becomes inaccessible.
- Preview rendering is derived from an already committed exact-version snapshot. A rate limit leaves the render set pending until the provider time; a terminal render failure leaves the raw checkpoint and metrics usable.
- A View-only authorizer can still supply content if the API allows it, but cannot create the file webhook.
- When file-webhook capacity is exhausted, metadata heartbeat and checkpoints remain valid; the team is not blocked.
- Disconnect removes the team's active authorization reference and webhook. Historical snapshots remain under the approved evidence-retention policy.

## 6. Google and Better Auth setup

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
- session and scoped-permission revocation test;
- duplicate participant provisioning converges on one event membership.

The VIT domain list comes from event configuration after VIT IT confirms it.

## 7. Notifications

### Participant status notifications

The current official outbound transport is Cloudflare Email Sending to each locked team member's Google-verified email. Cloudflare Email Routing owns the approved inbound support alias. It forwards through the event-owned email Worker to one verified operations mailbox. Board must approve the production sending domain/address, support alias and forwarding destination, final wording, reply-to, retention, and support policy before decisions are released. The separately permissioned communications editor publishes one immutable generic subject/introduction. The same publication contains the accepted-team venue, next steps, and Discord. The admission-decision mutation resolves that published policy. In the same transaction, it creates or refreshes the exact verified-email destination and inserts one pending delivery per locked member/application version. Each delivery stores the exact policy version. A manual retry preserves the version. The mutation then schedules a short claimed action. Messages are generic text. They contain no decision, private project/eligibility detail, track, venue, or Discord link. They point only to the authenticated participant portal. Inbound messages do not become commands or application evidence.

The delivery record distinguishes pending, sending, retry-wait, provider-accepted, delayed, delivered, bounced, failed, suppressed, unknown, and superseded states. A valid Cloudflare response must return one message ID. It must return exactly one delivered/queued/permanent-bounce outcome for the intended recipient. A structured error that proves non-acceptance can use the bounded automatic retry schedule. Cloudflare documents no send idempotency key. Therefore, a lost response, invalid or contradictory success, recipient mismatch, or expired claim becomes `unknown` immediately. The system never retries this outcome automatically.

One Cloudflare Email Sending Event Subscription per environment publishes delivered, deferred, bounced, failed, rejected, and complained events to an environment-specific Queue. `apps/email` validates the event schema and sending domain. It strips content/SMTP detail and signs the normalized callback. It posts the callback to `<CONVEX_SITE_URL>/communications/cloudflare-email/events`. Callback failures retry and then enter the configured DLQ. Convex verifies the context-separated HMAC and age. It deduplicates by Cloudflare event ID and orders by provider time plus event ID. Hard bounce, provider suppression, or complaint disables the exact destination. A soft exhausted bounce does not disable the destination. A receipt does not prove that the participant read or accepted anything. The system does not consume open/click events. Discord is the primary accepted-team community/support destination. It is not the sole official decision channel.

The repository creates both Queue resources through `pnpm --filter @code2create/email queue:create:<environment>`. The checked Wrangler `4.120.0` CLI cannot create an `email.sending` Event Subscription because it does not expose that source. Cloudflare's Queues dashboard is therefore the supported creation path. The release owner must select the exact sending domain and all six events. `pnpm --filter @code2create/email subscription:list:<environment>` verifies the resulting subscription through Wrangler. The owner must recheck the current CLI before each initial environment setup. Do not use another event source as a fallback.

A manual retry creates a new append-only delivery only from the latest definitively failed attempt. Exact-person `communications.delivery.manage`, current versions/application/email, a reason, and a Google session created within the last 15 minutes must pass first. `unknown` has no retry path until provider reconciliation. Disabling an address suppresses queued work. It does not claim that an already sending provider request was canceled.

The release inventory records the provider, verified sending domain/origin, templates, accessibility/plain-text rendering, unsubscribe or mandatory-operational-message policy, bounce route, rate limits, secrets, retention, staging sink, and production smoke-test recipient before decisions are released.

### Reviewer device registration

At device check:

- request permission;
- obtain the operating system's native token through `expo-notifications`;
- register the complete platform/provider/environment tuple against the installation ID;
- use FCM/production for Android and APNs/sandbox-or-production for iOS;
- send a test notification in staging/training;
- report permission/token failure to clock-in.

A token refresh updates the current installation through the same versioned registration command. If a provider later rejects a token, the failure mutation compares the delivery's token fingerprint with the device again before invalidating it; a delayed result cannot disable a newer token.

### Reviewer page send

An accepted page mutation creates the page and its device/token-bound delivery before scheduling the action. The action claims one attempt, then rechecks the live page, expiry, reviewer, active device, and token fingerprint. Android sends through Firebase Admin; iOS sends an ES256 provider token over HTTP/2 to the APNs host recorded with the device token. The payload contains the page ID and generic round/table alert text.

Do not include team project text, score, phone number, or private reason.

### Reviewer provider outcome

- Store the FCM message ID or APNs ID when the provider accepts the request.
- Disable only the still-matching token for terminal invalid-token responses.
- Retry transient provider/network failures at two and five seconds, at most three total claims and never beyond the page deadline.
- Keep reviewer acknowledgment separate from provider delivery.

The 90-second page deadline is based on the page record, not a provider outcome. Provider acceptance does not prove the device displayed the message.

## 8. VIT ID barcode and QR scanner release

Staff scan the printed barcode on an existing VIT ID with the event app camera. This is barcode decoding, not OCR or NFC. The participant website does not perform staffed attendance scans.

The Expo app includes:

- `expo-camera` for VIT ID barcodes, external-badge QR, dynamic attendance portal QR, review-presence team QR, and hall-location team QR;
- an app-owned adapter that accepts only the barcode symbologies and normalization rules approved after real-card testing;
- camera permission handling in development, preview, and production builds;
- secure auth/device registration and a SQLCipher pending-attendance queue whose database key is stored as device-only SecureStore material.

The current published attendance plan supplies the queue count and age limits; the configuration UI starts at eight scans and three minutes, within the enforced ranges of 1–25 scans and 30–600 seconds. Each row holds one operation ID, device sequence, original capture time, exact station/configuration, and credential payload only until a definite server outcome or expiry. A phone that is definitely offline creates new rows only for a VIT ID or event badge and directs a portal-QR holder to another online station. A portal row can remain only when a transmission that began online has an uncertain response, in which case replay uses that exact operation. A heartbeat exposes only count and oldest capture.

The event qualifies the proposed Android and iOS scanner models with representative current VIT IDs from available campuses and batches. The test identifies the actual barcode symbology. It covers first scan, repeat scan, stable value normalization, glare, worn cards, app resume, screen lock, rapid mixed barcode/QR scans, duplicates, low battery, and connection loss. It also covers 30 minutes of continuous station operation. An unreadable card uses the participant portal QR without losing attendance access.

The same installed application exposes hall mapping only to accounts with `floor.location.map` or `.override`. The operator explicitly selects Attendance, Reviews, or Hall map before the camera mounts. Only the hall claim mutation accepts a hall-location QR. The team's live dashboard always shows the QR. A table has no QR sticker. No shared decoder guesses the intended write.

VIT ID barcode enrollment is a protected staffed workflow:

1. scan the participant's fresh portal QR and require an accepted VIT event membership plus `attendance.credential.enrol` for the assigned current-plan station;
2. compare the visible card name, photo, and registration number with the participant record without capturing a card image;
3. scan the printed barcode twice on the provisioned phone;
4. send the decoded barcode value only to the protected backend command;
5. derive an event-scoped keyed fingerprint server-side, discard the raw value, and bind the fingerprint to that event membership;
6. show the accepted participant result to the operator.

Rebinding begins from the same portal-QR and visible-identity check, but requires `attendance.credential.rebind` for the exact participant person, a Google session younger than 15 minutes, a reason, and the current credential version. The first new-card scan creates a five-minute pending record while the old card remains active. Only a matching second scan atomically replaces the old binding and activates the new one. The pending expiry is version-checked and cannot undo a completed replacement.

Suspending an active VIT binding uses independent `attendance.credential.suspend` authority for the exact person, the same assigned current-plan phone, a recent Google session, visible identity confirmation, reason, and current version. It immediately marks the old barcode unusable and cancels an unfinished replacement in the same transaction. There is no resume path. The app continues to resolve that suspended row as current and offers only an independently permitted rebind to a different card; station enrollment cannot reactivate or bypass it.

The VIT ID is presentation evidence, not the account. Google identity and the event membership remain authoritative. The app never stores or logs the raw barcode value and never stores a card image. One active fingerprint can bind to only one event membership.

An external participant may receive an ordinary event badge with a random opaque QR. Operations generates a bounded local print sheet with `pnpm attendance:badges --count <n> --output <new-file.html>`. The command uses 32 random bytes per card, refuses batches above 500 and existing output paths, and prints only QR geometry plus a short reference; it creates no plaintext bearer manifest. The HTML and unused cards are controlled physical credentials. The QR contains no name, registration number, team, email, or session.

On an assigned current-plan phone, **Credential setup** first reads the participant's fresh portal QR and resolves the accepted external membership. Initial issue requires `attendance.badge.issue` for that exact person. Replacement and revocation use their own `attendance.badge.replace` and `attendance.badge.revoke` grants. Every command requires a Google session younger than 15 minutes and visible identity confirmation. Issue and replacement scan the chosen badge twice and compare the server-derived reference with the printed card. The first scan creates only a five-minute pending hash. The matching second scan activates it. Replacement changes old-active to old-replaced/new-active in the same transaction. Revocation checks the current credential version and reason. It then retires the active badge and any unfinished replacement together. Convex stores only the HMAC lookup, printed reference, state/version, and audit metadata. It never stores the bearer. Every participant can use a short-lived portal QR as the configured fallback. VIT students do not receive another physical attendance credential.

Production release inventory records:

- scanner installation, model, OS, app/runtime build, camera capability, station, charger, and spare owner;
- tested VIT campus/card batch, detected barcode symbology, phone/card compatibility result, repeated-scan count, value-normalization version, and approved fallback;
- external-badge print batch, read-back result, and issued/revoked/replaced counts;
- session station layout, direction, expected throughput, backup network, and operator shift;
- last successful online scan, pending queue age, and device heartbeat.

An attendance camera dependency or permission change requires a new signed build and full scanner rehearsal.

## 9. Private artifact and export bucket

The selected baseline is a private AWS S3 bucket in Mumbai (`ap-south-1`) after data-policy approval. It holds immutable round exports, expiring identifiable-attendance exports, four-hour-access emergency packs, downloaded backups, compressed Figma checkpoints, captured Figma previews, and any short-lived GitHub blob cache. Live counters and searchable metadata stay in Convex.

Configuration:

- public access blocked;
- bucket versioning on;
- server-side encryption with a dedicated KMS key;
- event-specific prefixes split by export, backup, and team integration;
- deployment credential can write/list only the active event prefixes;
- audit/backup readers use separate restricted IAM identities;
- lifecycle expiry matches approved retention;
- object checksum and application manifest retained.

Integration artifact layout uses opaque keyed path segments. The manifest stays in Convex; the bucket contains only private payloads:

```text
events/{opaqueEvent}/teams/{opaqueTeam}/figma/{opaqueFile}/{contentDigest}.json.gz
events/{opaqueEvent}/teams/{opaqueTeam}/figma/{opaqueFile}/previews/{opaqueNode}.png
events/{opaqueEvent}/teams/{opaqueTeam}/github/{opaqueRepository}/temporary/{blobSha}
events/{opaqueEvent}/exports/attendance/{opaqueExport}.csv
events/{opaqueEvent}/exports/emergency-packs/{opaquePack}/pack.html
events/{opaqueEvent}/exports/rounds/{opaqueRound}/{opaqueExport}/round.json
events/{opaqueEvent}/exports/rounds/{opaqueRound}/{opaqueExport}/scorecards.csv
backups/{eventSlug}/convex/{timestamp}-{digest}.zip
backups/{eventSlug}/convex/{timestamp}-{digest}.manifest.json
backups/{eventSlug}/staging-before-restore/{timestamp}-{digest}.zip
backups/{eventSlug}/rehearsals/{timestamp}-{digest}.result.json
```

Only files present for that provider are written. Figma JSON and previews follow the approved evidence-retention period. GitHub blob cache uses a short lifecycle tied to the review window. Attendance-export lifecycle follows the separately approved O-032 period; application access expires at the record's earlier server deadline. Emergency-pack application access ends four hours after request; its object lifecycle follows the approved incident-artifact period and does not make an expired pack printable again. A reviewer receives a short-lived signed object URL only after the backend verifies the assigned review and exact snapshot. An operator can open the same artifact only with `integration.artifact.read` for that exact team/integration; ordinary `integration.read` is insufficient. An attendance export instead requires `attendance.export.identifiable` for its exact session, requester ownership, fresh authentication, record/checksum revalidation, and an audited signed URL bounded to the earlier of 60 seconds or export expiry. An emergency pack uses separate event-scoped prepare/read/print grants, exact S3 object-version and checksum checks, fresh authentication for preparation and every print open, and a signed URL bounded to the earlier of 60 seconds or pack expiry.

Round export payload:

```text
round.json       event/round/rubric/panel metadata plus one nested adjudicated team entry
                 containing project/track, evidence, assignments, all scorecard versions,
                 evaluation, correction cases, and paper-review records
scorecards.csv   active result-rating rows plus explicit exclusion/withdrawal markers
```

The normalized close snapshot and file manifest stay in Convex. Each file manifest pins the bucket/region, opaque key, exact S3 object-version ID, byte count, and SHA-256. Bucket versioning and KMS encryption are required; generation reads those exact versions back before exposing the export as uploaded. A 60-second signed download and later verification also target the recorded version, never whichever object happens to be latest at the key. Superseded close revisions remain immutable under their original export IDs.

Convex backup ZIP files use a separate `backups/` prefix. The typed recovery command exports through the installed Convex CLI with file storage. It creates an order-independent semantic inventory for JSONL and byte hashes for stored files. It writes ZIP/manifest objects with KMS, SHA-256, `If-None-Match`, and a required S3 version ID. It reads back checksum, size, encryption, and bucket-key attributes before reporting success.

The staging rehearsal downloads the exact ZIP version from that manifest, uploads a pre-restore staging backup, imports with `--replace-all`, then exports staging again and compares every entry. It writes a versioned pass/fail result. Separate production-read, staging-write, and recovery-S3 credentials exist only in the operator environment described by `apps/backend/scripts/recovery/recovery.env.example`. Restore access is not held by the running application.

If VIT policy requires another provider/region, replace this decision before production registration data exists.

## 10. Environment matrix

| Item | Development | Staging | Production |
| --- | --- | --- | --- |
| Web | local/preview | protected staging domain | event domain |
| Convex | developer deployment | rehearsal deployment | production deployment |
| Better Auth | dev secret/clients | staging secret/clients | production secret/clients |
| OpenAI | dev project/key and synthetic corpus/input | staging project/key, approved staging novelty corpus, and intake/admission evals | production project/key, published privacy-reviewed novelty corpus, and separately published intake/admission model configs |
| Intelligence | local Flue Worker, synthetic aggregate snapshots, and development HMAC pair | `code2create-intelligence-staging`, staging Workers AI binding, staging Convex callback, and staging-only HMAC pair | `code2create-intelligence`, approved Workers AI model, production Convex callback, and production-only HMAC pair |
| Event app | local development build/scheme with synthetic barcode fixtures | locally signed build, staging update Worker/R2 bucket, representative VIT IDs, and rehearsal scanners | locally signed production build, production update Worker/R2 bucket, and provisioned scanner/reviewer fleet |
| GitHub | dev App | staging App/test repos | production App/team repos |
| Figma | dev OAuth/webhook/test files | staging OAuth/webhook/test files | approved production OAuth App and webhook endpoint |
| Push | test devices | reviewer training devices | registered event devices |
| Participant email | local normalized-event fixtures and test forwarding target | staging Cloudflare sending domain/identity, Event Subscription Queue/DLQ, email Worker/HMAC pair, Email Routing alias, and test recipients | verified Cloudflare production sending domain/identity, least-privilege send token, generic approved text, production Queue/DLQ and Worker, approved Email Routing alias/forward target, bounce/support procedure, and smoke-test recipient |
| Synesthesia | synthetic catalog and operator | approved staging catalog, scoped test operators, and licensed test account | frozen event catalog, named scoped operators/moderators, and approved licensed venue account |
| S3 | local/test bucket | staging integration/export prefixes | production integration/export prefixes |
| Recovery operator | no production key | exact disposable staging target and restore key | data-read export key only; destructive production restore uses a separate incident-controlled identity |
| Sentry | development | staging | production |

No callback URL, provider key, auth secret, user record, or push token is shared across staging and production.

## 11. CI

The complete pull-request gate must run:

1. dependency lockfile check;
2. formatting, lint, and TypeScript;
3. domain/unit tests;
4. Convex schema/function tests;
5. production builds for the participant and operations Vite applications plus the intelligence and update Workers;
6. a staging build for the optional handbook integration when Google identity or `handbook.read` changes;
7. intelligence protocol/permission/race tests and a strict Wrangler dry-run with the Workers AI and Durable Object bindings;
8. Expo export/config validation plus update-Worker dry-run build and protocol/concurrency tests;
9. Playwright against an isolated seeded deployment;
10. OpenAI embedding-width/corpus/race fixtures, Responses contracts/fallbacks, Workers AI/Flue contracts, and provider webhook fixtures;
11. secret scan.

The checked-in `Product checks` workflow covers a pinned TruffleHog scan of changed history and a frozen pnpm install. It covers repository lint and type-check, existing domain/Convex/intelligence/update-protocol tests, production builds for the two required Vite applications, the optional handbook integration build, and both Workers. It also covers public Expo config resolution and iOS/Android JavaScript bundle export with non-secret fixture configuration. The intelligence build validates its Cloudflare/Flue shape. The protected deployment workflow performs the environment-specific strict Wrangler deploy. The TruffleHog version is pinned by commit. It fails on verified, unknown, or unverified findings and scanner errors. The complete current Git history passed the same CLI before the gate was added. CI has no mobile/update private key.

The manually triggered `Staging release verification` workflow is also checked in. Before it opens a browser, an internal read-only Convex query verifies the exact staging event, Google configuration, current participant-policy acceptance, eligible participant membership, usable team, exact participant profile/team grants, and the operations account's event-scoped health and rehearsal grants. The query refuses a Convex deployment that does not set `C2C_DEPLOYMENT_ENVIRONMENT=staging`. A role does not satisfy a missing grant. Playwright then checks anonymous and authenticated participant/operations surfaces with protected storage states. A parallel read-only job uses only controlled synthetic fixtures to verify native-width OpenAI embeddings, one GitHub App repository/topic, one Figma file, and the intelligence Worker health route. Neither job prints a cookie, token, participant project, or provider body. The first controlled staging run, broader multi-client flow coverage, signed native artifacts, physical-device camera checks, and production-shaped provider/rate-limit rehearsals remain release blockers.

Main-branch release candidates must also run:

- locally signed staging APK/IPA when native inputs changed;
- Maestro smoke suite on at least Android and iOS plus physical-device VIT-barcode/QR smoke when attendance camera inputs changed;
- database migration/backfill check;
- recovery ZIP inventory and staging-target refusal tests;
- load smoke test;
- staging auth/integration health checks.

CI logs must not print environment values, cookies, webhook bodies, or provider responses containing tokens.

## 12. Production release

### GitHub environment contract

The manual **Deploy web surfaces** workflow selects the protected GitHub Environment named `staging` or `production`. Each environment supplies these non-secret variables:

- `CONVEX_URL`, `CONVEX_SITE_URL`, and `EVENT_SLUG`;
- `SENTRY_ORG`;
- `PARTICIPANT_SENTRY_DSN` and `PARTICIPANT_SENTRY_PROJECT`;
- `OPERATIONS_SENTRY_DSN` and `OPERATIONS_SENTRY_PROJECT`.

It supplies `CLOUDFLARE_ACCOUNT_ID`, a least-privilege `CLOUDFLARE_API_TOKEN`, and `SENTRY_AUTH_TOKEN` as GitHub Environment secrets. Production has required reviewers. The workflow validates configuration, builds all three user applications plus the intelligence Worker before deploying any of them, and uses strict Wrangler deploys against the exact environment-specific Worker names. Missing values stop before upload, and no secret value is printed. Custom-domain routing is added only after the exact staging and production domains are approved.

An authorized local staging release may use Wrangler's encrypted OAuth profile instead of copying a CI API token into the shell. The release validator checks the selected environment and release identity, while Wrangler remains the single authentication boundary and refuses the upload when its credential is absent or insufficient. Routine production release stays in the protected workflow above.

### Intelligence release contract

Before the first deployment in an environment, release operations generates two independent 32-byte-or-longer random HMAC secrets in a controlled session. The ingress value is written to the matching Convex environment and Worker secret store; the callback value is written to those same two matching stores. The values are passed through stdin or a protected secret manager and never printed, committed, placed in a command argument, or copied into a build variable. The Worker also receives the exact Convex callback URL; Convex receives the exact Worker origin.

Release order is:

1. deploy the tested additive Convex schema/functions containing the callback and brief state machine;
2. configure the matching Worker callback URL and both Worker HMAC secrets;
3. deploy the exact intelligence Worker build through `pnpm --filter @code2create/intelligence deploy:built` with `CLOUDFLARE_ENV` and the release ID;
4. verify `GET /health`, Worker name/environment, Workers AI binding, and Durable Object migration;
5. configure the matching Convex Worker URL and both Convex HMAC secrets; and
6. use a synthetic event and explicitly granted operator to request one brief, observe one callback, and verify that a repeated dispatch does not start another agent;
7. publish an enabled staging automation policy under the four exact configuration grants, create one selected synthetic health condition, and verify one committed signal/brief, unchanged suppression, owner/relevance display, recovery, and local-day count before disabling the policy again.

Do not wire production Convex to a staging Worker or vice versa. If the Worker is unhealthy, remove or disable the Convex Worker URL and leave brief generation unavailable; the health dashboard and event commands remain available. A Worker deployment is not complete evidence until the signed round trip succeeds through the intended Convex environment.

### Mobile and update release contract

Release operations creates the staging and production R2 buckets once. It sets a different `C2C_UPDATES_ADMIN_TOKEN` secret on each update Worker. It deploys each Worker through its checked-in Wrangler environment. The initial endpoints are `https://code2create-updates-staging.acmvit.workers.dev/manifest` and `https://code2create-updates.acmvit.workers.dev/manifest`. A later custom-domain binding must preserve the exact environment split. The same environment's URL is the sole `C2C_UPDATES_URL` in `apps/reviewer/.env.staging.local` or `.env.production.local`. The matching admin token and private-key path live in the corresponding ignored file under `apps/updates/`. A staging or production command loads only its matching file. Cloudflare receives neither the private key nor native signing credentials.

For each new application-version runtime:

1. deploy and health-check the environment's update Worker;
2. run `pnpm --filter @code2create/updates rollback:staging` or `rollback:production` to seed a signed embedded-bundle response;
3. from a clean commit, run one exact reviewer command through pnpm: `build:android:staging`, `build:android:production`, `build:ios:staging`, or `build:ios:production`; the command embeds that commit and refuses to overwrite an existing artifact;
4. install the signed artifact on the relevant fleet and complete native-push, camera, auth, deep-link, update, resume, and offline checks;
5. only then raise the backend minimum build or distribute the production artifact.

For a JavaScript-only release, commit the exact source. Publish it to staging with `pnpm --filter @code2create/updates publish:staging`. Test that commit on the staging fleet. Then run the production publisher. The publisher first checks `/health` and refuses a staging/production channel mismatch. A successful activation writes a non-secret receipt under `outputs/updates/`. A conflict means that another release advanced the runtime pointer after export. The operator inspects that release and starts again instead of forcing an overwrite.

### Before event freeze

1. Deploy additive Convex schema/functions to staging.
2. Run any backfill and verify counts.
3. Deploy all three Cloudflare staging web applications, the staging intelligence Worker, and the staging update Worker/R2 release; build the event app locally.
4. Run auth, novelty corpus/preview, deterministic/model intake, one signed operations brief, VIT-barcode/QR attendance, one-review, Synesthesia multi-client, integration, push, export, and incident smoke tests.
5. Publish the locally signed production event-app artifact and install it on reviewer and scanner devices after the production runtime has a signed rollback-to-embedded pointer.
6. Set the minimum build only after installation/training is complete.

### Production promotion

1. Run `pnpm recovery:backup` for the exact production deployment and release, then retain its local receipt and exact S3 ZIP/manifest versions.
2. Confirm every installed client meets the release's declared minimum version, then deploy the one current Convex function set.
3. Run protected production smoke queries with synthetic/admin test records.
4. Create staged Cloudflare deployments for all three web applications and the intelligence Worker; run deep-link, auth-origin, permission, asset, health, signed-ingress, and callback checks.
5. Promote the tested Cloudflare deployments without changing the environment pairings.
6. If needed, publish a same-runtime JavaScript update from a clean commit through the signed local publisher only after the identical commit passes against the staging update service and fleet.
7. Verify one synthetic novelty preview against the published native-width corpus. Verify one OpenAI interpretation/fallback and one bounded Workers AI operations brief. Verify one enrolled VIT ID barcode and one QR attendance transition. Verify GitHub/Figma callbacks, one test push, export bucket write, Sentry release, and dashboard release IDs.
8. Record the release in event configuration.

Do not change native dependencies, auth callback shape, rubric calculation, or destructive schema during a live round.

## 13. Schema and release changes

- The repository keeps one current endpoint, field, and workflow shape. Obsolete paths are removed rather than wrapped in compatibility adapters.
- Production schema and command-shape changes are frozen during live event operation. An emergency change uses a coordinated maintenance window, a declared minimum client version, and a complete rehearsal against a production-shaped copy before traffic resumes.
- Every self-hosted update matches the installed application-version runtime. Changing a native dependency or native configuration requires a new locally signed build and fleet rollout before dependent backend behavior is enabled.
- Event/rubric/panel configuration remains immutable and versioned; a code deploy never rewrites an active round’s meaning.
- Attendance plans, sessions, expectation snapshots, station assignments, and credential versions remain historical facts; a new release cannot reinterpret an open session.
- Track catalogs, novelty corpora/vector widths, intake shells, question policies, fallback prompts, model instructions, and output schemas remain immutable versions; active sessions do not silently change versions.
- A published Synesthesia window is immutable. Live operation uses only pause/resume, request state changes, or close; changing policy requires another non-overlapping draft and explicit publication.

## 14. Rollback

### Web

Move each affected Cloudflare domain to its last verified deployment and confirm its public environment values still target the current backend. Roll back one surface independently when the incident is isolated to it.

### Intelligence Worker

Publish a disabled operations-intelligence policy before changing the Worker, disable manual brief generation, and let or mark the one active brief terminal. Point Convex only to the last verified Worker release with the same protocol and HMAC pair. Recheck `/health` and one synthetic signed round trip before restoring manual generation or publishing an enabled policy. Do not roll back Convex event data or expose a direct model endpoint. If the service or HMAC material may be compromised, rotate the pair instead of restoring it.

### Reviewer update

Publish the signed rollback-to-embedded directive for the affected runtime, then verify launch on the staging fleet before applying it to production. To restore an earlier remote JavaScript version, revert or reapply that source in a new commit and publish a newly signed release; never reactivate an older manifest by falsifying its time. A native-runtime problem requires the prepared previous signed build or spare devices.

### Attendance scanner

Pause or redirect affected stations, retain pending operations, and move to the prepared previous signed build/spare fleet. Never downgrade a credential version or re-enable a suspended VIT barcode binding or revoked external badge to match an old client. Reconcile pending scans only after the restored build passes one online VIT-barcode and QR test against the current station configuration.

### Convex functions

Redeploy the last compatible source commit. Additive schema changes stay in place. Do not restore the database for an ordinary code defect.

### Novelty and intake model/config

If OpenAI becomes unreliable, remove its environment key through the controlled secret store. Novelty becomes unavailable, intake uses its published deterministic fallback, and admission remains human-only. Leave the published corpus and active draft pins unchanged; do not change vector width or re-embed only part of a corpus. Point new intake sessions to the last published compatible model configuration. Sessions already pinned to a valid older version continue. If a question configuration is unsafe, disable its model path so every affected session uses its already-published deterministic fallback; do not rewrite participant answers.

### Data

Use protected repair mutations for a small known error. Use backup restore only for a confirmed broad data incident under the rehearsed destructive-restore procedure.

### Auth/provider configuration

Restore the recorded previous secret/config version only if it is still secure. Never roll back to a compromised credential.

Every rollback records owner, reason, affected release IDs, start/end time, and verification result.

## 15. Secret rotation

Before launch, rehearse rotation for:

- Better Auth secret;
- Google client secret;
- OpenAI API key;
- GitHub App private key and webhook secret;
- Figma client secret and file-webhook passcodes;
- token-encryption key;
- attendance-key wrapping key;
- intelligence ingress and callback HMAC secrets;
- update Worker admin token and the locally held Expo Updates signing key;
- Cloudflare Email Sending API token and email-event HMAC secret;
- S3 application credential;
- Sentry auth token.

Token-encryption key rotation keeps the previous decrypt key until all active Figma authorizations are re-encrypted. Attendance-key wrapping rotation re-encrypts each event lookup key and verifies the authenticated ciphertext and key-check digest without changing a barcode fingerprint. A compromised event lookup key is different: pause VIT ID barcode acceptance, create a new event key set, and require staffed barcode re-enrollment while QR remains available. GitHub webhook-secret rotation may require an overlap or coordinated provider update. Figma passcode rotation updates each active webhook and verifies its new `PING` before discarding the old encrypted value.

Intelligence HMAC rotation pauses generation and waits for the active brief to settle because the protocol deliberately accepts one current secret in each direction. Rotate the Worker ingress value before Convex, then the Convex callback value before the Worker, verify one signed staging round trip, and resume. A suspected compromise rotates both directions and treats any in-flight brief as failed rather than adding a compatibility key. Rotating the Expo Updates signing key requires a new locally signed native build containing the replacement certificate before any update uses it.

## 16. Release acceptance

- Production auth callbacks accept only production origins/schemes.
- The first intake frame is **Hello.**, followed by **What is your project about?**, with one text box and no form, chat, or PPT UI.
- Every introduction asks one or two follow-ups: generated questions on the assisted path and published fallbacks in deterministic mode or when model work fails. Later checkpoints use their own published fixed-question plan.
- The complete track list is usable immediately after the opening save; at most one source-linked recommendation may appear later, and choosing another track cannot enter admission analysis as a negative feature.
- Novelty uses one immutable reviewed corpus, native 1,536-value `text-embedding-3-small` output, and a corpus-filtered vector index. The participant sees only the newest complete result; provider failure, sensitive input, duplicate requests, and stale completion leave submission usable and add nothing to application or judging evidence.
- OpenAI Responses requests set `store: false`, expose no tools, exclude identity/judging fields, and accept only the strict versioned output schema. The embeddings endpoint has no `store` parameter.
- A timeout, refusal, invalid output, quota error, or disabled model still lets a team finish and submit; a late result cannot replace the visible question.
- A generated question is short, single-purpose, easy to answer, source/configuration-linked, validated before display, and never treated as a participant answer.
- Event phase is server-assigned; the AI-recommended track, participant-chosen track, and freshness attestation remain separate fields. The submitted summary uses participant-written answers, not generated prose.
- Final submission requires a current explicit preview of the team, project, core track, and sponsor-track set, then atomically writes the immutable application and member/track lock.
- Admission configuration publishes one human policy, optional exact model child, and empty capacity bucket atomically. The first submitted application freezes the release; every application pins the same event policy, and human-only mode requires no placeholder model.
- Admission analysis applies the published deterministic experience band, returns a source-linked non-numeric structure, excludes identity/capacity/human-review/judging inputs, and cannot publish a decision. Human review works when it fails.
- The intelligence Worker exposes only `/health` and signed operations-brief ingress; it has no public Flue agent/chat route, Convex credential, or event command tool.
- Ingress and callback use different environment-specific HMAC secrets and contexts. Wrong content type, oversize body, stale timestamp, invalid signature, unknown field, or crossed staging/production URL is rejected before settlement.
- One brief ID creates one durable agent instance. A dispatch retry, callback retry, timeout, and competing settlement converge on one frozen source and one terminal Convex row.
- `operations.intelligence.read` and `operations.intelligence.generate` remain independent. The brief cites only aggregate source signals and cannot expose or invoke the drill-down actions it names.
- Intelligence-policy read, draft, validation, and publication remain independent. Two due evaluations create one signal/brief; unchanged health, cooldown, active work, the event-local daily limit, and relevance expiry cannot create an event command.
- Workers AI/Flue failure leaves the ordinary event-health query and every participant, admission, attendance, queue, review, score, access, incident, and Synesthesia command available.
- GitHub App permission screen contains no write/admin permission.
- A team can add repositories from different App installations and give each a required kind, purpose, branch/root, and order.
- Repository reordering checks the complete current binding set and all row versions; duplicate, missing, stale, and competing orders change nothing.
- The portal verifies `code2create-7-0` on every active repository; a missing topic does not cause an Administration permission request.
- Invalid, repeated, or out-of-order GitHub webhook deliveries do not double-count activity.
- Per-repository and combined metrics agree, duplicate fork commits are marked, and an inaccessible repository makes the combined view incomplete.
- A reviewer can switch through every repository in the fixed checkpoint set and browse it at the exact captured SHA without exposing an installation token.
- Adding, archiving, reordering, reclassifying, or refreshing a repository cannot change an existing review checkpoint set.
- Figma OAuth requests the documented read scopes and creates a file webhook only when access and plan capacity allow it.
- The OAuth grant includes `file_metadata:read`; existing development or staging authorizers reconnect once after this scope is introduced.
- A captured Figma checkpoint commits the raw full-file manifest and bounded render candidates before preview I/O begins; the raw document does not enter a Convex document.
- The image request names the exact captured provider version, successful PNGs are copied to private storage, and null/invalid/oversized/provider-limited results leave explicit partial or failure state without changing raw evidence.
- An assigned reviewer can switch pages/frames in the fixed checkpoint and receives a short URL for only the selected available fact. Another review, snapshot, team, stale lease, object key, or provider URL cannot be substituted.
- An assigned reviewer can traverse the pinned Figma tree, inspect bounded layer/component/prototype properties, and filter captured new/changed frames without a current Figma credential or live file request. An invalid size, checksum, provider version, node ID, or page offset is rejected.
- An assigned reviewer can inspect bounded named-version and comment facts only from the pinned snapshot. Counts and completeness agree with the immutable activity manifest, and comment state is labeled by capture time rather than treated as historical version content.
- The side-by-side frame view compares the current review evidence set with its linked previous judging set. It cannot substitute an intervening provider refresh, a fact from another binding/team/review, or a missing fact outside a truncated set.
- Provider rate limits leave an explicit metadata/content age and completeness state instead of blocking a review.
- A late metadata result cannot regress provider time/version, a lost worker cannot commit after its lease changes, and scheduler backlog is bounded to 64 dispatches per 15-second pass.
- Figma connection, file, metadata, full-sync, preview, and webhook transitions update the same team's current materialized summary transactionally; the event operations list reads one Figma row per team and loads file evidence only after exact-team expansion.
- Two team members see the same shared repository and Figma file sets, and any current lead can replace a revoked Figma authorizer without moving evidence ownership.
- Native provider acceptance, reviewer acknowledgment, page expiry, and operations fallback remain distinct; a stale invalid-token result cannot disable a refreshed registration.
- An accepted team can open published venue/date/next steps, locked summary, and Discord from the portal. One generic Cloudflare Email delivery is recorded per locked member. Duplicate/out-of-order Queue events converge through the signed bridge. Transport state is exact-person scoped. Unknown sends cannot be retried blindly. The approved inbound alias routes through Cloudflare Email Routing. No provider receipt becomes decision acknowledgment.
- Representative VIT ID barcodes and QR scan successfully in the signed production build on the provisioned fleet; an unreadable card has a complete portal-QR path.
- A raw VIT ID barcode value is discarded after event-scoped fingerprinting and never becomes participant identity. A suspended prior binding or replaced external badge is rejected online, while historical events remain traceable to the old credential reference.
- A repeated/simultaneous mixed-method scan creates one accepted transition; a connection loss remains pending and replays idempotently.
- Two consecutive attendance sessions, temporary exits/returns, a session extension, and an emergency roll call update every live projection without rewriting presence events.
- Two participants requesting/voting for one Synesthesia track converge on one request and one vote each; participant and operator views agree without refresh.
- A queue reader without moderation or report grants sees no internal note/report text, and an exact-request action cannot cross to another request.
- Two playback starts, pause, and close serialize so one request plays and no active item is stranded. The licensed application remains operator-controlled and no audio/provider token enters the platform.
- Suspending participant music access blocks the next request/vote/report but changes no event-account, attendance, project, admission, review, or score state.
- A compatible web/backend/mobile release survives rollback rehearsal.
- Both exact-version round-export objects plus one raw Figma checkpoint and one rendered frame reach the private bucket with matching checksums and no provider credential.
- A maximum accepted-cohort emergency pack reaches an exact KMS/versioned object and survives immediate read-back verification. It opens only through a fresh audited short URL. Its printed attendance/review serials reconcile through the existing two-person incident flows. Printing does not enable paper mode.
- A production bundle/secret scan finds no private credential.

Current milestone note: the metadata scheduler, exact provider retry gate, separate observed/captured versions, transactional team summary, lazy exact-team operations detail, normalized frame facts, private exact-version previews, bounded named-version/comment facts, and prior-judging-checkpoint comparison are implemented. The reviewer has a checksummed server-side browser over the full pinned raw tree, including bounded node properties, component metadata, styles, text, prototype starts/interactions, a changed-frame filter, captured activity, and stored side-by-side renders. Production exit still requires representative multi-client staging fixtures, provider-plan/rate-limit rehearsal, and private-storage verification with production-shaped configuration.

## References

- [OpenAI Responses API](https://developers.openai.com/api/reference/resources/responses)
- [OpenAI embeddings guide](https://developers.openai.com/api/docs/guides/embeddings)
- [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [OpenAI evaluation best practices](https://developers.openai.com/api/docs/guides/evaluation-best-practices)
- [OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data)
- [Flue Cloudflare target](https://flueframework.com/docs/guide/cloudflare-target/)
- [Flue routing](https://flueframework.com/docs/guide/routing/)
- [Flue agent API](https://flueframework.com/docs/reference/agent-api/)
- [Flue tools](https://flueframework.com/docs/guide/tools/)
- [Cloudflare Workers AI bindings](https://developers.cloudflare.com/workers-ai/configuration/bindings/)
- [Expo development builds](https://docs.expo.dev/develop/development-builds/introduction/)
- [Expo Camera barcode scanning](https://docs.expo.dev/versions/latest/sdk/camera/)
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
- [Expo Notifications native device tokens](https://docs.expo.dev/versions/latest/sdk/notifications/)
- [Firebase Admin Cloud Messaging](https://firebase.google.com/docs/cloud-messaging/send/admin-sdk)
- [Firebase Cloud Messaging error codes](https://firebase.google.com/docs/cloud-messaging/error-codes)
- [Apple token-based APNs connections](https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns)
- [Cloudflare Email Sending REST API](https://developers.cloudflare.com/email-service/api/send-emails/rest-api/)
- [Cloudflare Email Sending event subscriptions](https://developers.cloudflare.com/email-service/platform/event-subscriptions/)
- [Cloudflare Email Routing Worker API](https://developers.cloudflare.com/email-service/api/route-emails/email-handler/)
- [Cloudflare Queues consumer configuration](https://developers.cloudflare.com/queues/configuration/configure-queues/)
- [Expo Updates protocol](https://docs.expo.dev/technical-specs/expo-updates-1/)
- [Expo local application builds](https://docs.expo.dev/guides/local-app-overview/)
- [Expo Updates API and configuration](https://docs.expo.dev/versions/latest/sdk/updates/)
- [Cloudflare R2 Workers API and conditional writes](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
- [Cloudflare R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/)
- [Cloudflare Workers static assets](https://developers.cloudflare.com/workers/static-assets/)
- [Cloudflare SPA routing](https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/)

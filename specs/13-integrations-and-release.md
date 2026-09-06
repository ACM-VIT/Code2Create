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

### Published integration policy

The event owns one immutable published integration policy and at most one replaceable draft. A policy explicitly names its release label, required GitHub topic, active GitHub-repository cap per team, active Figma-file cap per team, and optional GitHub and Figma freeze timestamps. The first-run form exposes every field and starts with the canonical `code2create-7-0` topic; no event-specific topic, cap, or freeze is hidden in participant or provider code.

`configuration.integration.read`, `.draft.create`, `.validate`, and `.publish` are independent event-scoped permissions. Draft creation and publication require recent authentication, a reason, a stable client-operation ID, the expected event version, and the exact current draft ID or checksum. A retry returns its first result, a competing writer loses cleanly, every new draft row is immutable, and publication moves the event pointer and supersedes the prior release in one mutation.

Validation and publication reject a GitHub or Figma cap below the largest active team binding count already present in the bounded materialized team projections. Code-owned ceilings still bound request and transaction size; operations chooses the event policy inside those ceilings.

A changed required topic is authoritative as soon as the new release publishes. Existing bindings with the prior topic become `unknown` in current participant, operations, and new-review evidence reads. A bounded continuation job updates binding policy labels, marks team summaries conservatively incomplete, and queues provider reconciliation without scanning all resources in a foreground request. A review checkpoint never reuses an old-topic snapshot as current evidence.

Provider change commands use server time and reject when `serverNow >= freezeAt`. Actions pass a server timestamp into read preparation and the committing mutation rechecks after provider I/O, so a request that crosses the exact freeze boundary cannot commit a late repository or file change.

## 2. OpenAI novelty, intake, and admission

Create a separate OpenAI API project and restricted service key for development, staging, and production. The key lives only in the corresponding Convex environment.

### Live novelty embeddings

The participant novelty signal uses `POST /v1/embeddings` with `text-embedding-3-small`, `encoding_format: float`, and no `dimensions` override. The contract is exactly one finite 1,536-value vector per ordered input. Corpus import may send one bounded ordered batch. A participant preview sends exactly one normalized complete idea and stores only that complete-idea vector for the team lifecycle. The endpoint returns one JSON result rather than a partial-vector stream, so the browser debounces changed text and displays only the newest complete response. Unchanged text does not poll the provider.

Before provider I/O, one transactional team limiter and one sharded event-wide limiter admit the preview. Exact concurrent work for the same team and input fingerprint coalesces. `NOVELTY_GLOBAL_REQUESTS_PER_MINUTE` controls the event-wide provider budget and defaults to 1,800; staging must tune it against the OpenAI project's measured request limit and the returned request-limit headers. A refused or exhausted preview shows **Unavailable** and never delays autosave, proposal editing, or submission.

The production corpus contains 5 to 200 privacy-reviewed, non-identifying past-project summaries. Operations imports a complete draft under `configuration.novelty.entries.write`. Every vector must validate before one transaction replaces the set. A separately authorized and audited publication moves the event pointer. Development uses synthetic entries. Staging uses an approved non-production corpus. Production uses the reviewed event corpus. Environments do not share a key or corpus ID.

Before participant provider work, the backend rejects input that contains common contact, registration-number, URL-credential, or secret patterns. It stores only the input fingerprint, character count, team, person and corpus references, terminal category, and bounded result metadata. The participant sees only one whole-number result above the idea text box. The participant never sees a band, theme, prompt, summary, source key, similarity, vector, fingerprint, or provider request ID. Provider failure returns **Unavailable** and cannot block the proposal route.

Corpus policy release tests exact native width, complete ordered batches, duplicate or unsafe entries, score mapping, exact permissions, atomic replacement, stale publication, and a participant request racing newer text, submission, revision, and corpus publication. The release record names the corpus version and checksum, model, fixed width, score mapping, entry count, privacy approval, and aggregate provider latency and error results.

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
- prior generated-question wording, the target ordinal, question length limit, and reviewed common-idea patterns.

It excludes application-owned names, email, phone, registration number, Google claims, team invitations, auth/session data, admission state, GitHub/Figma credentials, reviewer context, and all score data. Before the request, a versioned deterministic filter replaces common contact, registration-number, URL-credential, and secret-token patterns inside participant free text. The original answer remains only in the project record; redacted request text is not copied into job or error logs.

The output can contain covered purpose keys, an optional abstract common-idea-pattern key, and one free-text `nextQuestion`. After schema parsing, application code rejects these conditions:

- unknown or unpublished keys;
- stale answer references;
- a question after ordinal two;
- a disallowed purpose;
- more than one question mark;
- normalized duplicate wording;
- blocked personal or credential patterns;
- prohibited wording; or
- text beyond the pinned limit.

The result cannot call a Convex function. An internal mutation writes a current valid result as an `intakeInterpretation`. It writes the question as a separate immutable `intakeGeneratedQuestion`. Both records use the exact input and policy versions.

### Prompt-injection and failure handling

The system instruction states that participant text is untrusted project material and cannot modify the schema, question policy, allowed IDs, or product rules. Delimiter text alone is not treated as security. The actual boundary is no tools, a closed output schema, server-side key and question-text validation, immutable version checks, and no authoritative write path.

Each answer-set, pinned-policy, and ordinal tuple has one deduplicated interpretation. The intake Workpool has 32 independent slots. It disables Workpool retry for the provider action. The OpenAI client uses the pinned timeout with `maxRetries: 0`. A version-bound 20-second end-to-end deadline covers both queue wait and provider work. When that deadline expires, the backend records one terminal category and advances through the deterministic no-model path; a late worker cannot reopen the question or leave the participant on a loading screen.

The pinned intake policy supplies the two fixed questions before provider work and one published fallback for each later ordinal. Timeout, refusal, incomplete output, invalid schema, grounding rejection, rate limit, or service outage records a non-sensitive failure category and selects that ordinal's fallback. The system still evaluates the second AI slot after the team answers the first generated-or-fallback question.

### Model and prompt release

A model configuration cannot move to `published` until its evaluation suite passes:

- ordinary short and long project descriptions;
- descriptions that already answer several fields;
- vague, multilingual, typo-heavy, and code-mixed answers;
- ideas across every configured event phase;
- prompt-injection attempts and fake IDs;
- claims without evidence;
- potential repeated, compound, overlong, overly technical, market-proof, scoring, novelty, and “why should you win?” questions;
- questions that should be answerable immediately in one to three sentences for each of the two generated slots;
- common-idea cases that should invite useful differentiation/follow-through without comparison, discouragement, or a novelty verdict;
- sensitive personal data pasted into a project answer;
- redaction fixtures for email, phone, registration number, URL credentials, and common secret formats;
- refusal, truncation, invalid output, timeout, and late-result fixtures.

Assertions cover schema validity, source attribution, grounding, published pattern IDs, question relevance, easy-answer rate, length, and one-question form. They also cover duplicate, prohibited-topic and personal-data rates, the exact two generated-or-fallback slots, no invented evidence, no authoritative selection, and no-model completion. Model or prompt changes publish a new immutable version. They do not rewrite active sessions.

The release suite uses a held-out set separate from prompt examples. Human reviewers label each question against short binary criteria: relevant to the team's text, answerable now without research, one idea, plain language, non-judgmental, and non-repetitive. Candidate and current configurations are compared on the same cases. The publication record stores thresholds and aggregate results. Opted-in production feedback adds new edge cases to a later suite; participant text does not enter an evaluation dataset by default.

### Data controls

Production sends `store: false` and does not use OpenAI Conversations or background responses. This avoids the Responses API's ordinary stored application state, but it is not the same as Zero Data Retention. By default, API abuse-monitoring logs may contain prompts and responses for up to 30 days. Before `applicationsOpenAt`, the event privacy owner must approve the disclosed use and effective retention controls. The owner must also decide whether to seek Modified Abuse Monitoring or Zero Data Retention.

### Admission recommendation contract

Before applications open, operations publishes the complete human rubric. The platform attaches the exact code-owned model configuration. The pair has one lifecycle: matching draft, validation, publication, supersession, and checksum checks. Publication also creates the policy's empty overall capacity bucket and moves both event pointers in the same Convex mutation. The first application closes later drafts and publication; a submission/publication race resolves to one policy through Convex transaction conflicts.

Admission analysis uses that policy's attached model ID, prompt, JSON Schema, evaluation-suite labels, deduplication key, and `admission_ai` Workpool whenever the provider key is configured. It runs only after final submission has created an immutable team and proposal snapshot. A valid post-submission team change supersedes that analysis and queues work for the new snapshot. There is no model fallback to a different policy release.

The request includes the redacted current proposal, optional additional information or links, follow-up answers, participant-visible questions, deterministic experience-band key, and published admission criteria. The request excludes names, contact and registration data, institution-prestige signals, raw eligibility evidence, human review and decision state, capacity, attendance, GitHub and Figma activity, judging rubrics, scores, and rankings.

The strict output contains:

- `recommendation: accept | waitlist | decline`;
- `criterionAssessments[]` with `meets | partly_meets | not_yet_clear` and application source references;
- concise strengths and concerns;
- confidence/limitations and the exact policy/schema version echoed from allowed IDs.

Application validation rejects numeric pseudo-scores, judging or winner language, unsupported facts, institution or prestige reasoning, unknown criteria or sources, overlong explanations, stale versions, and any attempt to encode an action. Valid output is an immutable advisory record. The decision command requires a human permission, an explicit outcome, and an audited `used | cleared | overridden | stale | unavailable` disposition. Refusal, timeout, invalid output, or a disabled provider leaves the human workflow usable.

The current lead can revise submitted proposal content before `applicationsCloseAt`. A revision creates a new immutable proposal version. It invalidates earlier human reviews and AI recommendations. It queues fresh optional analysis. A provider result for an older proposal version settles as stale.

An authorized operator can retry the current `refused`, `invalid`, `timed_out`, `rate_limited`, `failed`, or `stale` record while the application remains in active human review. This requires `application.ai_recommendation.run`, the current application version and recommendation ID, a reason, and a stable operation ID. It creates a new Workpool item against the application's pinned policy/model. It does not reuse or edit the failed row. A duplicate operation returns the same new row. Pending, running, successful, disabled, superseded, decided, and offer-stage work cannot retry. `application.ai_recommendation.read` remains a separate permission.

## 3. Durable intelligence Worker

The separate `apps/intelligence` package uses Flue on Cloudflare and is built through Vite. Its agents use Flue's OpenAI Responses provider with the environment's encrypted `OPENAI_API_KEY`. The backend and intelligence Worker use the same environment key. The brief, copilot, and autonomous-operations agents each pin an explicit model and agent version in source. A model, prompt, skill, tool, provider, or redaction change increments the affected agent version and passes its deterministic contract, privacy, adversarial, and live-provider evaluations before deployment.

The public application never receives the service HMACs. Convex authorizes the operator and issues a short-lived, route-bound stream capability. Browser `GET | HEAD` routes expose only sanitized Flue history, updates, and long-poll responses for the exact brief, copilot conversation, or autonomy run. Public SSE is rejected so an expired capability cannot leave an indefinite stream open. The projection keeps visible copilot operator/assistant text, generic reasoning lifecycle, fixed allowlisted tool names, duration, and status. Brief and autonomy traces omit all model prose. Every projection removes prompts, system text, reasoning text, tool arguments/results/errors, raw provider metadata, identities, files, secrets, and hidden data. Complete sanitized history remains cursor-pageable after reconnect; a small transport page is never treated as the whole trace.

Manual briefs remain one frozen-input job. Copilot turns are operator-authored and conversation-scoped. The autonomous agent is a separate event-run identity and has no chat/user-message ingress. Convex owns its immutable policy/source provenance, semantic work inbox, current authority, operation receipts, continuation outbox, typed recommendation records, and kill switch. The Worker owns only the durable reasoning execution. Its closed public lifecycle is planning, redacted reads, focused investigation, evidence criticism, typed proposal publication, and continuation.

An autonomous run may use as many model turns, investigator delegations, redacted read pages, reduction passes, proposals, and continuation submissions as it needs. Per-request body, response, provider-call, transaction, and page bounds protect infrastructure only. Every incomplete page or bounded reasoning batch persists an opaque cursor and exact snapshot, emits a nonterminal `continuing` checkpoint, settles the current Flue submission, and resumes through a backend-owned idempotent work item. Distinct health fingerprints, schedule slots, and manual requests remain in the durable inbox while one executor is active; only exact semantic duplicates coalesce. Provider congestion and transient interruption retry the same work item instead of terminalizing cognitive work.

The autonomy allowlist is the complete evidence scope, not a menu the model may prune. Its shared closed registry covers operations health and attention, review rounds and exceptions, attendance counts and operations, support load, intake jobs, admission jobs, participant deliveries, integration jobs, round exports, Synesthesia operations, and incident readiness. Trusted orchestration refreshes operations health first and traverses every authorized read to `isDone`, rejecting snapshot drift and cursor cycles. Unbounded actionable Convex sources append complete redacted temporal facts in their owning mutations. Each semantic inbox item freezes the high-watermark vector for all allowed fact sources; the full vector is source provenance, and the coordinates for currently qualifying policy areas distinguish signal episodes even when their aggregate health fields stay equal. The eventual run and each traversal use that exact frozen vector. Keyset pages return only versions effective at the frozen sequence, while bounded aggregate sources are captured once as immutable traversal JSON. Page-local evidence becomes individually bounded artifacts. Compact digests are navigation indexes over a lossless append-only finding and candidate catalog; fixed-size durable reduction passes page through the entire catalog without placing an unbounded event in one prompt or discarding facts between prompts. Derived records name one to four exact parents, so a durable support traversal can recover their complete source-leaf closure. The Worker uploads those canonical leaves in separately signed pages of at most four; Convex grounds every leaf against its completed read receipt, extends an ordered hash chain, and accepts a proposal only after the set is sealed. A repeated still-open effect appends the later run's sealed observation to the one human decision instead of discarding either run's evidence.

The autonomous agent has no generic mutation tool and no unattended execution mode. It can create only a typed recommendation that the published policy permits. Consequential effects still use a human-confirmed permissioned mutation with current versions. The kill switch, policy replacement, owner revocation, or event-state change cancels the authoritative run and schedules an idempotent abort. Admission and continuation requests expire after 30 seconds. A durable Worker run fence prevents delayed work from creating a submission after cancellation, including when no Flue instance existed at abort time.

All service requests use a strict closed schema, bounded body, canonical JSON, a millisecond timestamp within five minutes, and route-specific HMAC context. Ingress, callback/recommendation delivery, redacted reads/work authorization, and browser streams use independent environment-specific secrets of at least 32 UTF-8 bytes. Neither side logs a signed body, signature, provider body, prompt, or raw model/tool content. Cloudflare tracing keeps content capture disabled. A patch to the pinned Flue runtime lets the private router project a bounded native history before serialization; the frozen install verifies that patch.

Every product-terminal, canceled, or revoked autonomy path durably schedules an idempotent purge of the private read-page, target, cursor, digest, finding, candidate, hypothesis, support, and root-membership artifacts before terminal settlement or abort acknowledgement. The run Durable Object completes deletion independently; a recoverable provider or transport interruption remains nonterminal and retains those artifacts for continuation. The admission fence keeps exact replay receipts without a timer only while the run remains active. Its terminal-callback outbox atomically persists the strict callback and wakeup, pre-arms each retry before external I/O, and closes the fence only after Convex accepts or exactly replays the callback. Terminal settlement or a recorded abort deletes admission and pending rows in bounded pages and leaves the durable run-bound closed tombstone that makes later admission impossible. Native Flue history, sanitized public lifecycle history, and server-side sealed evidence follow their separately approved restricted trace or audit periods.

Staging and production require these paired values:

- Convex: `INTELLIGENCE_WORKER_URL`, `INTELLIGENCE_INGRESS_SECRET`, `INTELLIGENCE_CALLBACK_SECRET`, `INTELLIGENCE_READ_SECRET`, and `INTELLIGENCE_STREAM_SECRET`;
- Worker: the matching four secrets plus exact brief/autonomy callback, read, work-authorization, recommendation, and recommendation-evidence URLs;
- Worker secret: `OPENAI_API_KEY`.

Every configured service URL is a canonical HTTPS origin/endpoint outside loopback development. Development, staging, and production never share a URL or secret. The Worker has no Convex deployment credential and cannot bypass the signed, run-scoped routes. New intelligence jobs follow the same rule: one strict versioned input, closed reads/tools/output, explicit authority owner, durable idempotent identity, complete cursor traversal, defined retention, sanitized observable lifecycle, and no broad service credential or consequential command.

## 4. GitHub App

### Permissions and event topic

Register the production Code2Create GitHub App with:

- **Metadata: read**;
- **Contents: read**.

Subscribe only to:

- `push`;
- `installation`;
- `installation_repositories`.

The published integration policy supplies the required repository topic; the first release starts with `code2create-7-0`. `GET /repos/{owner}/{repo}/topics` needs only Metadata read, so the production App checks the current published value for every active repository at connection, readiness, and reconciliation.

GitHub's topic write endpoint is not a narrow “add topic” operation. `PUT /repos/{owner}/{repo}/topics` replaces the complete topic list and requires **Administration: write**. The selected production App therefore does not auto-write the topic. When it is missing, the portal shows the exact topic, asks a repository administrator to add it in GitHub, and rechecks without reinstalling the App.

If the board later requires automatic topic repair, ship it as a separate elevated App registration after security approval. That path must fetch the current list, merge the exact topic from the published integration policy, replace the list, and read it back. Do not add Administration write to the read-only evidence App.

Private repositories use the same Metadata and Contents read permissions as public repositories; they do not need the classic OAuth `repo` scope. Prefer **Only select repositories** during installation. If the installer authorizes all repositories or several repositories, the callback opens the verified installation’s paginated repository picker. Authorization alone never submits a repository: the lead explicitly adds each project repository with its role and purpose. Do not request Contents write, Actions, Secrets, Members, or user email for repository evidence.

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

| Value               | Use                                                                      |
| ------------------- | ------------------------------------------------------------------------ |
| `full_product`      | Full product or monorepo containing several application layers           |
| `frontend`          | Web or other client-facing interface                                     |
| `backend_api`       | API, server, worker, or backend service                                  |
| `mobile_app`        | Android, iOS, or cross-platform mobile client                            |
| `desktop_app`       | Desktop client                                                           |
| `ai_ml`             | Model, agent, inference, training, or evaluation code                    |
| `data_pipeline`     | Data ingestion, transformation, analytics, or dataset tooling            |
| `hardware_firmware` | Firmware, embedded software, HDL, or hardware-control code               |
| `infrastructure`    | Deployment, cloud, containers, observability, or infrastructure-as-code  |
| `library_sdk`       | Shared package, SDK, plugin, or reusable library                         |
| `docs_research`     | Project documentation, specifications, experiments, or research material |
| `other`             | Another role; a custom kind label is required                            |

The portal does not infer kind from languages or filenames. A team can change the kind or purpose before the integration freeze; the history records the previous values. External dependencies that the team cannot administer belong in the prior-work/tool disclosure, not in the connected-repository set.

Versioned event configuration supplies `maxActiveGitHubRepositoriesPerTeam` after the registered scale and GitHub rate budget are tested, so the limit is an explicit event policy rather than a one-repository product constraint. The UI explains the configured cap and lets a lead archive an old binding without deleting its checkpoints.

### Team connection

1. A team lead selects **Connect GitHub**.
2. The portal creates a one-use setup intent bound to event, team, person, and return route.
3. GitHub opens user authorization, including for an already-installed App. The callback lists accessible, non-suspended installations of this App and offers installation on another account.
4. The lead selects an account. A fresh account-bound authorization verifies their current access to that exact installation before connecting it. New installations use the installation callback. OAuth user tokens remain only in action memory, never browser storage or the database.
5. The portal lists only repositories currently granted to that installation.
6. **Add repository** asks for repository, tracked branch, optional project root, kind, custom kind when needed, purpose, and display order.
7. The backend verifies the event cap and that the repository is not already bound to another team in the event.
8. The backend reads repository metadata, topics, languages, the tracked head, and the commit/tree at that head.
9. It records the repository baseline SHA, topic state, repository creation/fork metadata, and first immutable snapshot.
10. The lead repeats the flow for every submitted repository and can start another App installation flow when the next repository belongs to a different account or organization.

One `teamIntegration` owns the ordered repository set. A GitHub installation can serve several repositories and several Code2Create teams, while one team can reference several installations. The application never asks for a personal access token.

### Authentication and API version

The backend signs a short-lived GitHub App JWT and mints an installation access token restricted to the repository needed by that job and to read permissions. Installation tokens expire after one hour. Mint one for a provider job, keep it only in action memory, and discard it after the call.

Every REST request sends `Accept: application/vnd.github+json` and the pinned `X-GitHub-Api-Version: 2026-03-10` header. Each request receives a fresh 30-second abort deadline. Initial authorization discovers user-accessible installations in pages of 100 (at most 10 pages, with an explicit error rather than a truncated selection). Account selection verifies the exact installation again using a fresh user token. Repository discovery reads 50 repositories at a time and returns an explicit continuation; the browser loads another page only on request. The API version is upgraded only after fixture and staging checks pass.

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

- `current_user:read`;
- `file_metadata:read`;
- `file_content:read`;
- `file_versions:read`;
- `file_comments:read`;
- `webhooks:write`.

The file-content scope is required because reviewers and teams need the document tree, components, styles, prototype structure, and rendered frames, not a metadata card. Comment read access supplies open/resolved collaboration context. The App never writes comments or file content.

Do not request `projects:read`, organization scopes, variables, libraries, or write scopes in the baseline. A later event may add `file_dev_resources:read` or `file_variables:read` only after a separate feature, plan check, consent text, and review. Variables API access is not available on every Figma plan.

The portal accepts a Figma file URL instead of listing a person's projects. Current-user access verifies the authorizing account through `/v1/me`; metadata access supports lightweight file freshness checks. Content access supplies the complete evidence snapshot through `GET /v1/files/:key`.

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
11. The file commit queues one leased file-context `FILE_UPDATE` setup when the authorizer has **Can edit** access and the plan has capacity. Setup creates the webhook as `PAUSED`, stores its ID and passcode digest, and then activates it. A lost worker resumes that exact webhook instead of creating a second active webhook.

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

The worker requests half-scale PNGs, downloads at most four concurrently, accepts no file over 8 MiB or preview set over 64 MiB, validates the PNG dimensions, and writes each successful render under a content-addressed private S3 key. It accepts only credential-free HTTPS URLs on Figma's exact `s3-alpha-sig.figma.com` render host, disables redirects, and aborts a download after 30 seconds. An unexpected host or later provider-host change fails closed as an unavailable render until the allowlist is deliberately updated. Figma's temporary URL is never stored or returned to a client. A leased job has an expiry recovery path, honors `Retry-After`, and reaches `ready`, `partial`, `rate_limited`, or `failed` without changing the raw snapshot. Individual null, oversized, invalid, download-failed, or upload-failed renders remain visible as unavailable frame facts.

An assigned reviewer loads the normalized page/frame index through the fixed review checkpoint and opens one successful preview through a fresh one-minute signed URL. After signing, a final mutation repeats the assignment and exact `review.evidence.read` check, then matches the checkpoint, binding, snapshot, preview set, frame fact, provider version, byte count, dimensions, checksum, private location, and remaining expiry before it audits and releases the URL. A protected raw-checkpoint URL applies the equivalent final check to the pinned snapshot and complete raw manifest. The same fixed-checkpoint boundary can read the gzip artifact server-side, verify both byte counts, SHA-256, and its internal provider version, then return one 60-child layer page with bounded layout, style, component, text, flow, and interaction facts. It can also return the stored version/comment facts without a live provider call.

For Review 2 and later, the current evidence set stores the latest lower-round-sequence evidence-set ID for that team. The reviewer comparison finds the same Figma binding in those two sets and joins their stored frame facts by node ID. It never uses the file snapshot's adjacent-provider-snapshot link, which may point to an incidental webhook or manual refresh rather than the previous judging context. Same semantic hash is unchanged; a different hash is changed. A node on only one side is added or removed only when the opposite selection is complete, otherwise it is uncertain. Side-by-side images are signed for one minute from the exact stored facts; one final transaction revalidates and audits both sides together before either URL is delivered. The comparison makes no Figma request.

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

The event-owned email Worker is the official outbound boundary. Each immutable communications policy selects Amazon SES or Cloudflare Email Sending for every message queued under that version. Cloudflare Email Routing owns the approved inbound support alias and forwards through the same Worker to one verified operations mailbox. Board must approve the production sending identity, provider, support alias and destination, wording, reply-to, retention, and support policy before decisions are released. The admission-decision mutation resolves that policy and, in the same transaction, refreshes the verified-email destination and inserts one pending delivery per deadline-frozen roster member and application version. Messages contain no decision, private proposal or eligibility detail, venue, or Discord link. They point only to the authenticated participant portal. Inbound messages do not become commands or application evidence.

The delivery record distinguishes pending, sending, retry-wait, provider-accepted, delayed, delivered, bounced, failed, suppressed, unknown, and superseded states. The email Worker normalizes a valid provider acceptance to one provider, one message ID, and one initial outcome. A structured error that proves non-acceptance can use the bounded automatic retry schedule. A lost response, invalid or contradictory success, recipient mismatch, or expired claim becomes `unknown` immediately. The system never retries or switches providers for this outcome automatically.

One Cloudflare Email Sending Event Subscription per environment publishes delivered, deferred, bounced, failed, rejected, and complained events to an environment-specific Queue. `apps/email` validates the event schema and sending domain, strips content/SMTP detail, and signs the normalized callback to Convex. Callback failures retry and then enter the configured DLQ. SES sends currently record the provider's accepted message ID and remain queued until SES event ingestion is configured; the product does not claim a delivered state from acceptance alone. A provider receipt never proves that the participant read or accepted anything. The system does not consume open/click events. Discord is the primary accepted-team community/support destination, not the sole official decision channel.

The repository creates both Queue resources through `pnpm --filter @code2create/email queue:create:<environment>`. Wrangler creates the staging `email.sending` Event Subscription through `pnpm --filter @code2create/email subscription:create:staging`. The command fixes the exact sending domain and all six lifecycle events. `pnpm --filter @code2create/email subscription:list:<environment>` verifies the resulting subscription. Do not use another event source as a fallback.

A manual retry creates a new append-only delivery only from the latest definitively failed attempt. Exact-person `communications.delivery.manage`, current versions/application/email, a reason, and a current scoped authorization must pass first. `unknown` has no retry path until provider reconciliation. Disabling an address suppresses queued work. It does not claim that an already sending provider request was canceled.

The release inventory records the provider, verified sending domain/origin, templates, accessibility/plain-text rendering, unsubscribe or mandatory-operational-message policy, bounce route, rate limits, secrets, retention, staging sink, and production smoke-test recipient before decisions are released.

### External participant event passes

Offer confirmation queues a separate event-pass email for each external participant. It embeds that participant's static QR and includes signed **Add to Google Wallet** and **Add to Apple Wallet** actions. Google Wallet uses a service account authorized under the environment's issuer ID. Apple Wallet uses the environment's Pass Type ID certificate, private key, and Apple WWDR certificate; Convex serves the signed `.pkpass` from a short signed download URL under `CONVEX_SITE_URL`. Development, staging, and production use separate issuers/certificates/keys where the providers permit it, and never share the wallet-download signing secret.

Release validation sends the pass to a controlled external-participant account, verifies the QR resolves repeatedly without rotation, installs it in both wallet platforms on representative devices, and confirms that an internal participant receives no event-pass delivery. The wallet pass and email QR must decode to the same opaque payload without exposing name, email, or registration number in the barcode.

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

The page deadline uses the published response window, which defaults to 30 seconds, and is stored on the page record. Provider acceptance does not prove the device displayed the message. The separate arrival window applies after page acceptance.

### Reviewer phone escalation

The reviewer-page flow sends push first. If push has no usable device address, the backend can call immediately. Otherwise, the first unanswered reminder can ask the event-owned voice service to place one synthesized phone call. Its delay is half the response window, capped at 30 seconds, so the default page can escalate after 15 seconds before its 30-second deadline.

The call claim requires:

- the current active page;
- server time before page expiry;
- current reviewer consent for purpose `reviewer_substitute_page`;
- the page chain's exact, still-current `review.substitute.page` grant IDs;
- the current consented E.164 destination;
- the published script and locale;
- no accepted or declined page acknowledgement; and
- a stable delivery ID.

The backend resolves purpose, consent, locale, script policy, source state, and permission before dispatch. The voice service receives only the stable delivery ID, destination, bounded synthesized script, and signed callback URL. It receives no proposal, participant, score, reviewer note, consent record, grant, or private incident text.

The backend stores call dispatch, claim, provider acceptance, queue, ring, answer, completion, definite failure, cancellation, and ambiguous state. It deduplicates signed provider events and rejects an event ID reused with different content. A push or call provider acceptance does not acknowledge the page. An in-app acknowledgement prevents a later claim. A claim that already committed can still produce a call, but it never changes the in-app response.

The voice service is reusable. Its contract includes a closed purpose key, consent policy, script version, audience type, permission rule, retention rule, and callback schema. Participant review call-ups use their separate purpose and consent policy and the team lead's current saved profile phone. Reviewer consent does not authorize participant calls. Scheduled reviewer shift reminders currently use push; voice for those reminders remains a tracked implementation task.

## 8. VIT ID barcode and QR scanner release

Staff scan the printed barcode on an existing VIT ID with the event app camera. This is barcode decoding, not OCR or NFC. The participant website does not perform staffed attendance scans.

The Expo app includes:

- `expo-camera` for VIT ID barcodes, static external event passes, external physical-ID barcodes, optional external-badge QR, and review-presence team QR;
- an app-owned adapter that accepts only the barcode symbologies and normalization rules approved after real-card testing;
- camera permission handling in development, preview, and production builds;
- secure auth/device registration and a SQLCipher pending-attendance queue whose database key is stored as device-only SecureStore material.

The current published attendance plan supplies the queue count and age limits; the configuration UI starts at eight scans and three minutes, within the enforced ranges of 1–25 scans and 30–600 seconds. Each row holds one operation ID, device sequence, original capture time, exact station/configuration, and credential payload only until a definite server outcome or expiry. A phone can queue VIT ID, static external-pass, or event-badge scans. Replay uses the exact original operation and device sequence. A heartbeat exposes only count and oldest capture.

The event qualifies the proposed Android and iOS scanner models with representative current VIT IDs from available campuses and batches and representative external physical IDs. The test identifies the actual barcode symbologies. It covers first scan, repeat scan, stable value normalization, glare, worn cards, app resume, screen lock, rapid mixed barcode/QR scans, duplicates, low battery, and connection loss. It also covers 30 minutes of continuous station operation. An unreadable VIT card uses registration-number lookup; an unreadable external pass or ID uses verified-email lookup and visible photo-ID verification.

VIT ID barcode enrollment is a protected staffed workflow:

1. scan the VIT ID barcode and parse its registration number;
2. require one eligible, accepted RSVP membership plus `attendance.credential.enrol` for the assigned current-plan station;
3. show and compare the authoritative participant name, registration number, institution, and team with the visible card, without capturing a card image;
4. send the decoded barcode value only to the protected backend command;
5. derive an event-scoped keyed fingerprint server-side, discard the raw value, and bind the fingerprint to that event membership;
6. show the accepted participant result and let the operator record staffed venue arrival.

Rebinding begins by resolving the participant from the current VIT ID or registration-number lookup and visibly checking identity. It requires `attendance.credential.rebind` for the exact participant person, a current scoped authorization, a reason, and the current credential version. The first new-card scan creates a five-minute pending record while the old card remains active. Only a matching second scan atomically replaces the old binding and activates the new one. The pending expiry is version-checked and cannot undo a completed replacement.

Suspending an active VIT binding uses independent `attendance.credential.suspend` authority for the exact person, the same assigned current-plan phone, a recent Google session, visible identity confirmation, reason, and current version. It immediately marks the old barcode unusable and cancels an unfinished replacement in the same transaction. There is no resume path. The app continues to resolve that suspended row as current and offers only an independently permitted rebind to a different card; station enrollment cannot reactivate or bypass it.

The VIT ID is presentation evidence, not the account. Google identity and the event membership remain authoritative. The app never stores or logs the raw barcode value and never stores a card image. One active fingerprint can bind to only one event membership.

An external participant may receive an ordinary event badge with a random opaque QR. Operations generates a bounded local print sheet with `pnpm attendance:badges --count <n> --output <new-file.html>`. The command uses 32 random bytes per card, refuses batches above 500 and existing output paths, creates the file atomically with owner-only `0600` permissions, and prints only QR geometry plus a short reference; it creates no plaintext bearer manifest. The HTML and unused cards are controlled physical credentials. The QR contains no name, registration number, team, email, or session.

On an assigned current-plan phone, **First check-in** reads the participant's static external event pass and resolves the accepted external membership. Staff visibly compare the person and physical ID, then scan that ID barcode once to bind an event-scoped HMAC; verified-email lookup is the fallback when either barcode cannot be read. Optional printed-badge issue requires `attendance.badge.issue` for that exact person. Replacement and revocation use their own `attendance.badge.replace` and `attendance.badge.revoke` grants. Every badge command requires current scoped authorization and visible identity confirmation. Issue and replacement scan the chosen badge twice and compare the server-derived reference with the printed card. Convex stores only the HMAC lookup, printed reference, state/version, and audit metadata. It never stores the badge bearer. VIT students do not receive another physical attendance credential or an attendance QR.

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

Only files present for that provider are written. Figma JSON and previews follow the approved evidence-retention period. GitHub blob cache uses a short lifecycle tied to the review window. Attendance-export lifecycle follows the separately approved O-032 period; application access expires at the record's earlier server deadline. Emergency-pack application access ends four hours after request; its object lifecycle follows the approved incident-artifact period and does not make an expired pack printable again. A reviewer receives a short-lived signed object URL only after the backend verifies the assigned review and exact snapshot. An operator can open the same artifact only with `integration.artifact.read` for that exact team/integration; ordinary `integration.read` is insufficient. The operator URL is delivered only after a final audited mutation rechecks the exact current grant, latest snapshot, artifact manifest, checksum, and expiry. An attendance export instead requires `attendance.export.identifiable` for its exact session, requester ownership, current authorization, record/checksum revalidation, and an audited signed URL bounded to the earlier of 60 seconds or export expiry. An emergency pack uses separate event-scoped prepare/read/print grants, exact S3 object-version and checksum checks, current authorization for preparation and every print open, and a signed URL bounded to the earlier of 60 seconds or pack expiry.

Round export payload:

```text
round.json       event/round/rubric/panel metadata plus one nested adjudicated team entry
                 containing proposal, evidence, assignments, all scorecard versions,
                 evaluation, correction cases, and paper-review records
scorecards.csv   active result-rating rows plus explicit exclusion/withdrawal markers
```

The normalized close snapshot and file manifest stay in Convex. Each file manifest pins the bucket/region, opaque key, exact S3 object-version ID, byte count, and SHA-256. Bucket versioning and KMS encryption are required; generation reads those exact versions back before exposing the export as uploaded. A 60-second signed download and later verification also target the recorded version, never whichever object happens to be latest at the key. Superseded close revisions remain immutable under their original export IDs.

Convex backup ZIP files use a separate `backups/` prefix. The typed recovery command exports through the installed Convex CLI with file storage. It creates an order-independent semantic inventory for JSONL and byte hashes for stored files. It writes ZIP/manifest objects with KMS, SHA-256, `If-None-Match`, and a required S3 version ID. It reads back checksum, size, encryption, and bucket-key attributes before reporting success.

The staging rehearsal downloads the exact ZIP version from that manifest, uploads a pre-restore staging backup, imports with `--replace-all`, then exports staging again and compares every entry. It writes a versioned pass/fail result. Separate production-read, staging-write, and recovery-S3 credentials exist only in the operator environment described by `apps/backend/scripts/recovery/recovery.env.example`. Restore access is not held by the running application.

If VIT policy requires another provider/region, replace this decision before production registration data exists.

## 10. Environment matrix

| Item              | Development                                                                                                                                      | Staging                                                                                                                                    | Production                                                                                                                                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web               | local/preview                                                                                                                                    | protected staging domain                                                                                                                   | event domain                                                                                                                                                                                                                                |
| Convex            | developer deployment                                                                                                                             | rehearsal deployment                                                                                                                       | production deployment                                                                                                                                                                                                                       |
| Better Auth       | dev secret/clients                                                                                                                               | staging secret/clients                                                                                                                     | production secret/clients                                                                                                                                                                                                                   |
| OpenAI            | dev project/key and synthetic corpus/input                                                                                                       | staging project/key, approved staging novelty corpus, and intake/admission evals                                                           | production project/key, published privacy-reviewed novelty corpus, and separately published intake/admission model configs                                                                                                                  |
| Intelligence      | local Flue Worker, repository development OpenAI key, synthetic aggregate snapshots, exact local service URLs, and four development HMAC domains | `code2create-intelligence-staging`, encrypted staging OpenAI key, exact staging Convex service URLs, and four staging-only HMAC domains    | `code2create-intelligence`, encrypted production OpenAI key, approved pinned OpenAI model, exact production Convex service URLs, and four production-only HMAC domains                                                                      |
| Event app         | local development build/scheme with synthetic barcode fixtures                                                                                   | locally signed build, staging update Worker/R2 bucket, representative VIT IDs, and rehearsal scanners                                      | locally signed production build, production update Worker/R2 bucket, and provisioned scanner/reviewer fleet                                                                                                                                 |
| GitHub            | dev App                                                                                                                                          | staging App/test repos                                                                                                                     | production App/team repos                                                                                                                                                                                                                   |
| Figma             | dev OAuth/webhook/test files                                                                                                                     | staging OAuth/webhook/test files                                                                                                           | approved production OAuth App and webhook endpoint                                                                                                                                                                                          |
| Push              | test devices                                                                                                                                     | reviewer training devices                                                                                                                  | registered event devices                                                                                                                                                                                                                    |
| Outbound calls    | local signed callback fixtures and test destinations                                                                                             | staging voice Worker/provider account, consent fixtures, approved synthesized reviewer script, and test phones                             | event-owned voice service, approved provider account and reviewer script, consented destinations, consent records, rate limits, audit, and runner fallback                                                                                  |
| Participant email | local normalized-event fixtures, wallet-signing fixtures, and test forwarding target                                                              | staging Cloudflare sending domain/identity, Event Subscription Queue/DLQ, email Worker/HMAC pair, Email Routing alias, Google/Apple Wallet credentials, and test recipients | verified Cloudflare production sending domain/identity, least-privilege send token, generic approved text, production Queue/DLQ and Worker, approved Email Routing alias/forward target, wallet signing credentials, bounce/support procedure, and smoke-test recipient |
| Synesthesia       | synthetic catalog and operator                                                                                                                   | approved staging catalog, scoped test operators, and licensed test account                                                                 | frozen event catalog, named scoped operators/moderators, and approved licensed venue account                                                                                                                                                |
| S3                | local/test bucket                                                                                                                                | staging integration/export prefixes                                                                                                        | production integration/export prefixes                                                                                                                                                                                                      |
| Recovery operator | no production key                                                                                                                                | exact disposable staging target and restore key                                                                                            | data-read export key only; destructive production restore uses a separate incident-controlled identity                                                                                                                                      |
| PostHog           | one EU project with development release tags                                                                                                     | the Code2Create EU project with staging release tags and source maps                                                                       | the Code2Create EU project with production release tags and source maps                                                                                                                                                                     |

No callback URL, provider key, auth secret, user record, or push token is shared across staging and production.

## 11. CI

The complete pull-request gate must run:

1. dependency lockfile check;
2. formatting, lint, and TypeScript;
3. domain/unit tests;
4. Convex schema/function tests;
5. production builds for the landing, participant, and operations Vite applications plus the intelligence, update, email, and voice Workers;
6. intelligence protocol/permission/race tests and a strict Wrangler dry-run with the OpenAI secret and Durable Object bindings;
7. Expo export/config validation plus update-Worker dry-run build and protocol/concurrency tests;
8. Playwright against an isolated seeded deployment;
9. OpenAI embedding-width, corpus, race, Responses, fallback, and Flue provider contracts; email, call, GitHub, and Figma webhook fixtures;
10. secret scan.

The checked-in `Product checks` workflow uses a pinned TruffleHog scan and a frozen pnpm install. It runs on pull requests and pushes to `staging` and `main`. It runs repository lint, type checks, domain and Convex tests, service protocol tests, autonomy-boundary evaluation, all Vite builds, and all Worker builds. It also validates public Expo configuration and exports the iOS and Android JavaScript bundles with non-secret fixtures. GitHub Actions verifies releases. It does not deploy a Cloudflare Worker and holds no Cloudflare, mobile, or update-signing credential.

The manually triggered `Staging release verification` workflow is also checked in. Before it opens a browser, an internal read-only Convex query verifies the exact staging event, Google configuration, published participant and communications policies, a current operations-health snapshot, one eligible participant with a complete accepted-team home, that participant's exact profile/team/integration read grants, and the operations account's event-scoped health and rehearsal grants. The query refuses a Convex deployment that does not set `C2C_DEPLOYMENT_ENVIRONMENT=staging`. A role does not satisfy a missing grant. Playwright then checks anonymous and authenticated participant/operations surfaces with protected storage states. A parallel read-only job uses only controlled synthetic fixtures to verify native-width OpenAI embeddings, one GitHub App repository/topic, one Figma file, and the intelligence Worker health route. Neither job prints a cookie, token, participant project, or provider body. The first controlled staging run, broader multi-client flow coverage, signed native artifacts, and physical-device camera checks remain release blockers.

The staging GitHub provider fixture receives `RELEASE_GITHUB_REQUIRED_TOPIC` from the protected environment and must match the staging event's published integration topic. The check does not embed an event-specific topic in release code.

Production candidates merged to `main` must also run:

- locally signed staging APK/IPA when native inputs changed;
- Maestro smoke suite on at least Android and iOS plus physical-device VIT-barcode/QR smoke when attendance camera inputs changed;
- database migration/backfill check;
- recovery ZIP inventory and staging-target refusal tests;
- staging auth/integration health checks.

CI logs must not print environment values, cookies, webhook bodies, or provider responses containing tokens.

## 12. Production release

### Git branch and Cloudflare Workers Builds contract

Cloudflare Workers Builds owns Worker deployment from GitHub. `staging` is the sole release branch for every staging Worker. `main` is the sole release branch for every production Worker. A staging Worker treats `staging` as its production branch inside Cloudflare; this wording describes Cloudflare's deployment channel, not the Code2Create production environment. Non-production branch builds are disabled. A feature branch cannot create a preview or replace staging.

Each Worker connects separately to `ACM-VIT/Code2Create`. This preserves independent build logs, runtime bindings, secrets, rollback, and failure state. No build deploys another Worker as a side effect.

| Staging Worker                     | Root directory      | Build command                   | Deploy command                   |
| ---------------------------------- | ------------------- | ------------------------------- | -------------------------------- |
| `code2create-landing-staging`      | `apps/landing`      | `pnpm cloudflare:build:staging` | `pnpm cloudflare:deploy:staging` |
| `code2create-participant-staging`  | `apps/web`          | `pnpm cloudflare:build:staging` | `pnpm cloudflare:deploy:staging` |
| `code2create-operations-staging`   | `apps/ops`          | `pnpm cloudflare:build:staging` | `pnpm cloudflare:deploy:staging` |
| `code2create-intelligence-staging` | `apps/intelligence` | `pnpm cloudflare:build:staging` | `pnpm cloudflare:deploy:staging` |
| `code2create-updates-staging`      | `apps/updates`      | `pnpm cloudflare:build:staging` | `pnpm cloudflare:deploy:staging` |
| `code2create-email-staging`        | `apps/email`        | `pnpm cloudflare:build:staging` | `pnpm cloudflare:deploy:staging` |
| `code2create-voice-staging`        | `apps/voice`        | `pnpm cloudflare:build:staging` | `pnpm cloudflare:deploy:staging` |

Production uses the same one-Worker-per-application shape from `main`:

| Production Worker          | Public domain                            | Root directory      | Build command                      | Deploy command                      |
| -------------------------- | ---------------------------------------- | ------------------- | ---------------------------------- | ----------------------------------- |
| `code2create-landing`      | `c2c.acmvit.in`, `code2create.acmvit.in` | `apps/landing`      | `pnpm cloudflare:build:production` | `pnpm cloudflare:deploy:production` |
| `code2create-participant`  | `c2c.sh`                                 | `apps/web`          | `pnpm cloudflare:build:production` | `pnpm cloudflare:deploy:production` |
| `code2create-operations`   | `ops.c2c.sh`                             | `apps/ops`          | `pnpm cloudflare:build:production` | `pnpm cloudflare:deploy:production` |
| `code2create-intelligence` | `intelligence.c2c.sh`                    | `apps/intelligence` | `pnpm cloudflare:build:production` | `pnpm cloudflare:deploy:production` |
| `code2create-updates`      | `updates.c2c.sh`                         | `apps/updates`      | `pnpm cloudflare:build:production` | `pnpm cloudflare:deploy:production` |
| `code2create-email`        | `email.c2c.sh`                           | `apps/email`        | `pnpm cloudflare:build:production` | `pnpm cloudflare:deploy:production` |
| `code2create-voice`        | `voice.c2c.sh`                           | `apps/voice`        | `pnpm cloudflare:build:production` | `pnpm cloudflare:deploy:production` |

Every Worker build sets `NODE_VERSION=24.18.0` and `PNPM_VERSION=11.18.0`. Cloudflare supplies `WORKERS_CI`, `WORKERS_CI_BRANCH`, and `WORKERS_CI_COMMIT_SHA`. Cloudflare's production-branch setting owns the branch boundary. The environment-specific package commands set `CLOUDFLARE_ENV` and `VITE_DEPLOYMENT_ENVIRONMENT`, and the Vite deployments use `WORKERS_CI_COMMIT_SHA` as `VITE_RELEASE_ID`. Do not create user-defined copies of the `WORKERS_CI_*` values.

The three browser applications use these additional build values:

| Application | Plain build variables                                                                                                                                         | Secret build variables |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| Landing     | `VITE_POSTHOG_PROJECT_TOKEN`, `VITE_POSTHOG_HOST`, `POSTHOG_CLI_HOST`, `POSTHOG_CLI_PROJECT_ID`                                                               | `POSTHOG_CLI_API_KEY`  |
| Participant | `VITE_CONVEX_URL`, `VITE_CONVEX_SITE_URL`, `VITE_EVENT_SLUG`, `VITE_POSTHOG_PROJECT_TOKEN`, `VITE_POSTHOG_HOST`, `POSTHOG_CLI_HOST`, `POSTHOG_CLI_PROJECT_ID` | `POSTHOG_CLI_API_KEY`  |
| Operations  | `VITE_CONVEX_URL`, `VITE_CONVEX_SITE_URL`, `VITE_EVENT_SLUG`, `VITE_POSTHOG_PROJECT_TOKEN`, `VITE_POSTHOG_HOST`, `POSTHOG_CLI_HOST`, `POSTHOG_CLI_PROJECT_ID` | `POSTHOG_CLI_API_KEY`  |

The remaining Workers need only the common build-tool versions. Their operational configuration belongs to the matching Worker runtime, not to Workers Builds:

| Worker       | Wrangler-owned bindings and plain runtime values                                                                                                                                                                     | Runtime secrets                                                                                                                                                                                                   |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Intelligence | OpenAI Responses, admission-fence Durable Object, exact Ops origin, exact Convex callback/read/work/recommendation URLs, `POSTHOG_PROJECT_TOKEN`, `POSTHOG_HOST`, `C2C_DEPLOYMENT_ENVIRONMENT`, and `C2C_RELEASE_ID` | `OPENAI_API_KEY`, `INTELLIGENCE_INGRESS_SECRET`, `INTELLIGENCE_CALLBACK_SECRET`, `INTELLIGENCE_READ_SECRET`, `INTELLIGENCE_STREAM_SECRET`; the URLs and Ops origin may also be stored as encrypted Worker secrets |
| Updates      | environment-specific R2 bucket and `UPDATE_CHANNEL`                                                                                                                                                                  | `C2C_UPDATES_ADMIN_TOKEN`                                                                                                                                                                                         |
| Email        | environment-specific Queue consumer and dead-letter Queue                                                                                                                                                            | `CONVEX_EMAIL_EVENT_CALLBACK_URL`, `EMAIL_EVENT_CALLBACK_SECRET`, `EMAIL_ROUTING_ADDRESS`, `EMAIL_ROUTING_FORWARD_TO`, `EMAIL_SENDING_DOMAIN`                                                                     |
| Voice        | outbound-call Durable Object, environment-specific `PUBLIC_BASE_URL`, and `OUTBOUND_CALL_PRIMARY_PROVIDER` (`twilio` or `sarvam`)                                                                                     | `OUTBOUND_CALL_REQUEST_SECRET`, `OUTBOUND_CALL_EVENT_SECRET`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, `SARVAM_VOICE_AGENTS_API_KEY`, `SARVAM_ORG_ID`, `SARVAM_WORKSPACE_ID`, `SARVAM_APP_ID`, `SARVAM_APP_VERSION`, `SARVAM_CONNECTION_ID`, `SARVAM_AGENT_PHONE_NUMBER` |

The PostHog project token is an ingestion identifier rather than an administrative credential. Store it as a Worker runtime value and a Convex deployment environment value; never use the personal `POSTHOG_CLI_API_KEY` at runtime. The matching PostHog ingest host is the first-party proxy `https://i.c2c.sh`. Server-side AI telemetry is content-free and must use the same environment-specific project as the corresponding clients.

The Cloudflare GitHub App and the Worker-specific build token are configured in Cloudflare. They do not become repository or application environment variables. Cloudflare's automatic dependency installation uses the workspace lockfile. Watch paths remain unrestricted for the first staging release so a shared package, generated API, specification, lockfile, or patch cannot leave one Worker stale.

Cloudflare does not deploy Convex. The tested staging Convex functions and environment configuration must exist before a dependent Worker commit reaches `staging`. Do not make one Worker deploy Convex: seven independent builds could race and would give a frontend deployment backend authority. The production Worker connections and custom domains are configured only after the staging release is accepted.

An authorized local staging release may use Wrangler's encrypted OAuth profile for recovery. The release validator checks the selected environment and release identity, and Wrangler refuses upload without its own credential. Routine staging deployment comes only from `staging`; routine production deployment will come only from `main`.

### Intelligence release contract

Before the first deployment in an environment, release operations generates four independent secrets of at least 32 UTF-8 bytes in a controlled session: intelligence ingress, callback/recommendation delivery, redacted read/work authorization, and browser stream capability. Each value is written only to the matching Convex environment and Worker secret store that consumes it. Values pass through stdin or a protected secret manager and are never printed, committed, placed in a command argument, or copied into a build variable. The Worker also receives the exact Convex brief/autonomy callback, read, work, recommendation, and recommendation-evidence URLs plus the exact operations-dashboard origin; Convex receives the exact Worker origin.

Release order is:

1. deploy the tested Convex functions containing the semantic autonomy inbox, operation receipts, continuation/abort outboxes, callback, redacted paged-read boundary, work-authorization boundary, recommendation boundary, stream-ticket actions, and manual-brief state machine;
2. configure the matching Worker callback/read/work/recommendation/recommendation-evidence URLs, exact operations origin, encrypted `OPENAI_API_KEY`, and all four Worker HMAC secrets;
3. deploy the exact intelligence Worker build through `pnpm --filter @code2create/intelligence deploy:built` with `CLOUDFLARE_ENV` and the release ID;
4. verify `GET /health`, Worker name/environment, OpenAI readiness, and Durable Object migration;
5. configure the matching Convex Worker URL and all four Convex HMAC secrets;
6. use a synthetic event and explicitly granted operator to request one brief, observe one callback, open its sanitized paged trace, submit one copilot turn through Convex, observe its assistant/tool lifecycle, and verify that exact retries do not start duplicate work; and
7. publish an enabled staging autonomy policy under the four exact configuration grants; create distinct synthetic signal changes plus scheduled and manual work while one run is active; verify durable serial draining, a multi-page/multi-submission continuation, exact citation provenance, one human-approved typed recommendation, complete sanitized history after reconnect, transient retry, and an immediate reasoned kill/abort before disabling the policy again.

Do not wire production Convex to a staging Worker or vice versa. If the Worker is unhealthy, use the autonomy kill switch and leave brief/copilot generation unavailable; the health dashboard and ordinary event commands remain available. A Worker deployment is not complete evidence until every signed route and the durable continuation round trip succeeds through the intended Convex environment.

### Mobile and update release contract

Release operations creates the staging and production R2 buckets once. It sets a different `C2C_UPDATES_ADMIN_TOKEN` secret on each update Worker. It deploys each Worker through its checked-in Wrangler environment. The staging endpoint is `https://code2create-updates-staging.acmvit.workers.dev/manifest`; production uses `https://updates.c2c.sh/manifest`. The same environment's URL is the sole `C2C_UPDATES_URL` in `apps/reviewer/.env.staging.local` or `.env.production.local`. The matching admin token and private-key path live in the corresponding ignored file under `apps/updates/`. A staging or production command loads only its matching file. Cloudflare receives neither the private key nor native signing credentials.

For each new application-version runtime:

1. deploy and health-check the environment's update Worker;
2. run `pnpm --filter @code2create/updates rollback:staging` or `rollback:production` to seed a signed embedded-bundle response;
3. from a clean commit, run one exact reviewer command through pnpm: `build:android:staging`, `build:android:production`, `build:ios:staging`, or `build:ios:production`; the command embeds that commit and refuses to overwrite an existing artifact;
4. install the signed artifact on the relevant fleet and complete native-push, camera, auth, deep-link, update, resume, and offline checks;
5. only then raise the backend minimum build or distribute the production artifact.

For a JavaScript-only release, commit the exact source. Publish it to staging with `pnpm --filter @code2create/updates publish:staging`. Test that commit on the staging fleet. Then run the production publisher. The publisher first checks `/health` and refuses a staging/production channel mismatch. A successful activation writes a non-secret receipt under `outputs/updates/`. A conflict means that another release advanced the runtime pointer after export. The operator inspects that release and starts again instead of forcing an overwrite.

The update Worker streams public R2 objects directly to the phone. Authenticated publishing accepts at most 25 MiB per immutable asset, 10 MiB of release metadata, and 1 KiB for activation. It rejects a missing or false `Content-Length` once the streamed body crosses the same limit. The publisher checks all assets and complete release metadata before its first upload, gives each HTTP call a deadline, and reads only bounded JSON/error responses. Registration and activation reject a release time more than five minutes ahead of Worker time so a misconfigured workstation clock cannot poison the monotonic release pointer.

### Before event freeze

1. Deploy additive Convex schema/functions to staging.
2. Run any backfill and verify counts.
3. Deploy all three Cloudflare staging web applications, the staging intelligence Worker, and the staging update Worker/R2 release; build the event app locally.
4. Run auth, novelty corpus/preview, deterministic/model intake, one signed operations brief, VIT-barcode/QR attendance, one-review, Synesthesia multi-client, integration, push, export, and incident smoke tests.
5. Publish the locally signed production event-app artifact and install it on reviewer and scanner devices after the production runtime has a signed rollback-to-embedded pointer.
6. Set the minimum build only after installation/training is complete.

The ordered review-queue aggregate has no compatibility or backfill path. Its first release to an environment is allowed only while `teamRoundStates` is empty, before any review round has routed a team. Run `pnpm --filter @code2create/backend exec convex data teamRoundStates --deployment <exact-deployment> --limit 1 --format json` before that release; any returned row blocks it. A queued source row without its same-transaction aggregate entry is an integrity error; participant queue reads fail instead of estimating from a scan or a partial projection.

### Production promotion

1. Run `pnpm recovery:backup` for the exact production deployment and release, then retain its local receipt and exact S3 ZIP/manifest versions.
2. Confirm every installed client meets the release's declared minimum version, then deploy the one current Convex function set.
3. Run protected production smoke queries with synthetic/admin test records.
4. Create staged Cloudflare deployments for all three web applications and the intelligence Worker; run deep-link, auth-origin, permission, asset, health, signed-ingress, and callback checks.
5. Promote the tested Cloudflare deployments without changing the environment pairings.
6. If needed, publish a same-runtime JavaScript update from a clean commit through the signed local publisher only after the identical commit passes against the staging update service and fleet.
7. Verify one synthetic novelty preview against the published native-width corpus. Verify one OpenAI interpretation/fallback and one bounded OpenAI/Flue operations brief. Verify one enrolled VIT ID barcode and one QR attendance transition. Verify GitHub/Figma callbacks, one test push, export bucket write, PostHog release, and dashboard release IDs.
8. Record the release in event configuration.

Do not change native dependencies, auth callback shape, rubric calculation, or destructive schema during a live round.

## 13. Schema and release changes

- The repository keeps one current endpoint, field, and workflow shape. Obsolete paths are removed rather than wrapped in compatibility adapters.
- Production schema and command-shape changes are frozen during live event operation. An emergency change uses a coordinated maintenance window, a declared minimum client version, and a complete rehearsal against a production-shaped copy before traffic resumes.
- Every self-hosted update matches the installed application-version runtime. Changing a native dependency or native configuration requires a new locally signed build and fleet rollout before dependent backend behavior is enabled.
- Event/rubric/panel configuration remains immutable and versioned; a code deploy never rewrites an active round’s meaning.
- Attendance plans, sessions, expectation snapshots, station assignments, and credential versions remain historical facts; a new release cannot reinterpret an open session.
- Novelty corpora and vector widths, intake shells, question policies, fallback prompts, model instructions, and output schemas remain immutable versions. Active sessions do not silently change versions.
- A published Synesthesia window is immutable. Live operation uses only pause/resume, request state changes, or close; changing policy requires another non-overlapping draft and explicit publication.

## 14. Rollback

### Web

Move each affected Cloudflare domain to its last verified deployment and confirm its public environment values still target the current backend. Roll back one surface independently when the incident is isolated to it.

### Intelligence Worker

Use the autonomy kill switch before changing the Worker, disable manual brief/copilot generation, and verify that the active autonomy run is canceled with its abort outbox acknowledged. Point Convex only to the last verified Worker release with the exact same protocol and four HMAC domains. Recheck `/health`, all signed route boundaries, sanitized history, and one multi-submission continuation before restoring manual generation or publishing an enabled autonomy policy. Do not roll back Convex event data, discard its semantic inbox, synthesize operation receipts, or expose a direct model endpoint. If service or HMAC material may be compromised, rotate the affected domains instead of restoring them.

### Reviewer update

Publish the signed rollback-to-embedded directive for the affected runtime, then verify launch on the staging fleet before applying it to production. To restore an earlier remote JavaScript version, revert or reapply that source in a new commit and publish a newly signed release; never reactivate an older manifest by falsifying its time. A native-runtime problem requires the prepared previous signed build or spare devices.

### Attendance scanner

Pause or redirect affected stations, retain pending operations, and move to the prepared previous signed build/spare fleet. Never downgrade a credential version or re-enable a suspended VIT barcode binding or revoked external badge to match an old client. Reconcile pending scans only after the restored build passes one online VIT-barcode and QR test against the current station configuration.

### Convex functions

Redeploy the last compatible source commit. Additive schema changes stay in place. Do not restore the database for an ordinary code defect.

### Novelty and intake model/config

If OpenAI becomes unreliable, remove its environment key through the controlled secret store. Novelty becomes unavailable, intake uses its reviewed fallback, and admission remains available for human review without an AI result. Leave the published corpus and active draft pins unchanged; do not change vector width or re-embed only part of a corpus. Roll back the code-owned question release if its prompt or validation is unsafe; do not add an event-level toggle or rewrite participant answers.

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
- GitHub star OAuth App client secret;
- GitHub App private key and webhook secret;
- Figma client secret and file-webhook passcodes;
- token-encryption key;
- attendance-key wrapping key;
- intelligence ingress, callback/recommendation, read/work, and stream-capability HMAC secrets;
- update Worker admin token and the locally held Expo Updates signing key;
- email-Worker send HMAC, selected Amazon SES and/or Cloudflare Email Sending credentials, and email-event HMAC secret;
- S3 application credential;
- PostHog CLI personal API key.

Token-encryption key rotation keeps the previous decrypt key until every active Figma access/refresh token and every unexpired pending or verifying OAuth PKCE verifier is re-encrypted. The bounded, cursor-resumable status and rotation commands cover each owner separately; the previous key is removed only after a complete dry run reports no live ciphertext on it. Attendance-key wrapping rotation authenticates and re-encrypts each event lookup key without changing a barcode fingerprint. A compromised event lookup key is different: pause VIT ID barcode acceptance, create a new event key set, and require staffed barcode re-enrollment while QR remains available. GitHub webhook-secret rotation may require an overlap or coordinated provider update. Figma passcode rotation updates each active webhook and verifies its new `PING` before discarding the old encrypted value.

Intelligence HMAC rotation uses the autonomy kill switch, pauses manual generation, and waits for the matching abort/terminal receipts because the protocol accepts one current secret per domain. Rotate ingress Worker-first then Convex; rotate callback/recommendation and read/work Convex-first then Worker; rotate stream capability on both sides before issuing another ticket. Verify every signed staging route and one continuation after each change. A suspected compromise rotates all four domains and cancels in-flight work rather than adding a compatibility key. Rotating the Expo Updates signing key requires a new locally signed native build containing the replacement certificate before any update uses it.

## 16. Release acceptance

- Production auth callbacks accept only production origins/schemes.
- The first intake frame is **Hello.**, followed by **What is your project about?**, with one text box and no form, chat, or PPT UI.
- Every introduction asks two published fixed questions followed by two required AI-attempted slots. Each later slot shows a validated question grounded in current team answers or its published fallback within 20 seconds. Later checkpoints use their own published fixed-question plan.
- Novelty uses one immutable reviewed corpus, native 1,536-value `text-embedding-3-small` output, and a corpus-filtered vector index. The participant sees only the newest complete result; provider failure, sensitive input, duplicate requests, and stale completion leave submission usable and add nothing to application or judging evidence.
- OpenAI Responses requests set `store: false`, expose no tools, exclude identity/judging fields, and accept only the strict versioned output schema. The embeddings endpoint has no `store` parameter.
- A timeout, refusal, invalid output, quota error, or disabled model selects the published fallback and still lets a team finish and submit; a late result cannot replace the visible question.
- A generated question is short, single-purpose, easy to answer, source/configuration-linked, validated before display, and never treated as a participant answer.
- Event phase is server-assigned. The freshness attestation remains a separate participant fact. The submitted proposal uses participant-written answers, not generated prose.
- Final submission requires a current explicit preview of the team and proposal. It atomically starts the first immutable application snapshot. Before the applicable class deadline, a valid team change or lead proposal revision appends a new immutable snapshot and invalidates stale human and AI output.
- Admission configuration publishes one human policy, its code-owned exact model child, and an empty capacity bucket atomically. The first validating/finalizing submission attempt freezes the release, and every completed application pins the same event policy.
- Admission analysis applies the published deterministic experience band, returns a source-linked non-numeric structure, excludes identity/capacity/human-review/judging inputs, and cannot publish a decision. Human review works when it fails.
- A holder of `application.ai_recommendation.run` can retry only the current failed or stale analysis during active review. The command keeps the old result, checks current application/recommendation versions, records a reason and audit event, and creates no duplicate on replay. Reading the result still needs `application.ai_recommendation.read`.
- The intelligence Worker exposes `/health`, strict signed brief/copilot/autonomy ingress and abort/continuation routes, and read-only ticketed sanitized history. It has no Convex credential, raw Flue history route, generic tool, or event command tool.
- Ingress, callback/recommendation, read/work authorization, and browser streams use different environment-specific HMAC contexts and secrets. Wrong content type, oversize body, stale timestamp, invalid signature, unknown field, expired ticket, disallowed SSE, or crossed staging/production URL is rejected before protected content or settlement.
- One brief ID creates one durable agent instance. A dispatch retry, callback retry, timeout, and competing settlement converge on one frozen source and one terminal Convex row.
- `operations.intelligence.read` and `operations.intelligence.generate` remain independent. The brief cites only aggregate source signals and cannot expose or invoke the drill-down actions it names.
- Autonomy-policy read, draft, validation, publication, and kill authority remain independent. Exact duplicate triggers coalesce, while distinct signal fingerprints, schedule slots, and manual requests are durably queued even during another run.
- An autonomy run traverses every allowed redacted read to a stable `isDone`, resumes after infrastructure boundaries, and retains exact page-operation/snapshot provenance. No product quota or one-shot prompt makes later evidence, reasoning turns, investigators, or typed proposals unreachable.
- The autonomous agent can create only policy-allowed typed recommendations. It cannot execute a materially consequential command; approval rechecks the deciding human's exact permission and the frozen target version.
- The sanitized replayable trace exposes generic model/tool lifecycle and allowed visible copilot text without prompt, system, reasoning, tool arguments/results/errors, raw provider content, identity, or secret leakage.
- Killing, superseding, revoking the owner, or leaving live operation cancels the authoritative run and retries the exact Worker abort until acknowledged. A late read, proposal, callback, or continuation cannot revive it.
- OpenAI/Flue failure leaves the ordinary event-health query and every participant, admission, attendance, queue, review, score, access, incident, and Synesthesia command available.
- GitHub App permission screen contains no write/admin permission.
- A team can add repositories from different App installations and give each a required kind, purpose, branch/root, and order.
- Retrying one repository or Figma-file add with the same operation ID and participant input returns the original binding before provider I/O. A newer repository head, Figma version, or published integration policy cannot turn that retry into a different request or create another baseline artifact.
- Repository reordering checks the complete current binding set and all row versions; duplicate, missing, stale, and competing orders change nothing.
- The portal verifies the current published topic on every active repository, beginning with canonical `code2create-7-0`; a missing topic does not cause an Administration permission request.
- Operations can independently read, draft, validate, and publish the integration policy. Stale event versions, stale draft IDs/checksums, reused operation IDs with different input, and cap reductions below active binding counts change nothing.
- Publishing a required-topic change makes old-topic bindings unknown immediately, resumes through bounded reconciliation, and prevents new review evidence from treating an old-topic snapshot as current.
- GitHub and Figma change commands succeed immediately before their configured server-time freeze and fail at or after it, including when provider I/O began before the boundary.
- Invalid, repeated, or out-of-order GitHub webhook deliveries do not double-count activity.
- Per-repository and combined metrics agree, duplicate fork commits are marked, and an inaccessible repository makes the combined view incomplete.
- A reviewer can switch through every repository in the fixed checkpoint set and browse it at the exact captured SHA without exposing an installation token.
- Adding, archiving, reordering, reclassifying, or refreshing a repository cannot change an existing review checkpoint set.
- Figma OAuth requests the documented read scopes and creates a file webhook only when access and plan capacity allow it.
- A committed Figma file queues webhook setup transactionally. A worker loss before creation, after paused-webhook attachment, or during activation resumes through one leased setup path; concurrent recovery cannot create two active webhooks, and a dedicated bounded sweep retries a stranded pending/error setup.
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
- An accepted team can open published venue/date/next steps, its deadline-frozen application summary, and Discord from the portal. One generic provider-pinned email delivery is recorded per roster member. Duplicate/out-of-order Cloudflare Queue events converge through the signed bridge. Transport state is exact-person scoped. Unknown sends cannot be retried or moved to another provider blindly. The approved inbound alias routes through Cloudflare Email Routing. No provider receipt becomes decision acknowledgment.
- Representative VIT and external physical-ID barcodes plus static external event-pass QR scan successfully in the signed production build on the provisioned fleet; unreadable credentials have complete registration-number or verified-email fallback paths.
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
- [Amazon SES v2 SendEmail API](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_SendEmail.html)
- [Amazon SES attachments](https://docs.aws.amazon.com/ses/latest/dg/attachments.html)
- [Cloudflare Queues consumer configuration](https://developers.cloudflare.com/queues/configuration/configure-queues/)
- [Expo Updates protocol](https://docs.expo.dev/technical-specs/expo-updates-1/)
- [Expo local application builds](https://docs.expo.dev/guides/local-app-overview/)
- [Expo Updates API and configuration](https://docs.expo.dev/versions/latest/sdk/updates/)
- [Cloudflare R2 Workers API and conditional writes](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
- [Cloudflare R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/)
- [Cloudflare Workers static assets](https://developers.cloudflare.com/workers/static-assets/)
- [Cloudflare SPA routing](https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/)
- [Cloudflare Workers Builds configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)
- [Cloudflare Workers Builds branch control](https://developers.cloudflare.com/workers/ci-cd/builds/build-branches/)
- [Cloudflare Workers Builds monorepos and Wrangler environments](https://developers.cloudflare.com/workers/ci-cd/builds/advanced-setups/)

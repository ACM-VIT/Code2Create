# Code2Create intelligence Worker

This Cloudflare Worker hosts the Flue agents used by the operations dashboard. Convex remains the authority for event state, permissions, autonomous-run scheduling, typed recommendation proposals, and every operator-approved effect. Every agent can access only its closed, redacted, signed projection routes; the autopilot is further restricted to the read set frozen into its run policy. The Worker cannot invoke event commands or make consequential changes directly.

There are four separate agent surfaces:

- an operator-requested operations brief with a grounded, Convex-published result;
- a subject-private operations copilot conversation;
- the operations autopilot, which drains durable semantic work, exhaustively pages every policy-approved read, investigates and criticizes evidence, and either records observations or proposes typed recommendations for human review.
- an event-owned episode investigator, with one durable instance per correlated operational situation and typed hypotheses and forecasts published back to Convex.

Autopilot runs have no product-level limit on model turns, investigations, read pages, proposals, or total reasoning time. Each network request, model response, database transaction, and history page stays technically bounded; durable continuations and opaque cursors carry unfinished work into later Flue submissions. A run stops only after its durable work is exhausted, its authority is revoked, or it reaches an explicit terminal result. A run-scoped admission-fence Durable Object serializes initial admission, continuation, and revocation so a delayed request cannot resurrect a stopped run.

The shared closed read registry is the complete data scope of a policy: operations health and attention, review rounds and exceptions, attendance counts and operations, floor-mapping progress, support load, intake jobs, admission jobs, participant deliveries, integration jobs, round-export jobs, Synesthesia operations, and incident readiness. The Worker traverses every allowed source to `isDone`; the model may prioritize reasoning but cannot silently omit a source. Convex freezes each temporal source's high-watermark on the semantic inbox item, so queued source episodes remain independently reconstructible even when aggregate health looks unchanged.

Private evidence artifacts form a bounded-fan-in support DAG. Bounded model findings are catalog entries, not the only copy of evidence. Before publishing a typed recommendation, the Worker durably expands the selected candidate's complete source-leaf closure and uploads at most four exact citations per signed page. Convex grounds and hash-chains every page, then returns a sealed evidence-set identity; the proposal carries that seal instead of flattening an arbitrarily large citation set into one request. Every product-terminal, canceled, or revoked path durably schedules its idempotent private-artifact purge before terminal settlement or abort acknowledgement; deletion then completes independently on the run Durable Object. A recoverable provider or transport interruption is deliberately nonterminal and retains those artifacts for continuation. The admission fence retains exact replay receipts without a timer while the run is active. Its durable terminal-callback outbox persists the strict callback and next alarm atomically, re-arms before external I/O, and closes the fence only after Convex accepts or exactly replays the callback. Terminal settlement or a recorded abort deletes admission receipts in bounded pages and leaves only the durable run-bound closed tombstone that prevents re-admission.

## Local development

Install from the workspace root:

```sh
pnpm install --frozen-lockfile
```

Run the Worker:

```sh
pnpm dev:intelligence
```

The repository-root `pnpm dev` command supplies matching local Convex/Worker HMAC values, service URLs, the stream secret, the exact operations origin, and the existing `OPENAI_API_KEY` from the ignored repository-root `.env.local`. Agent calls use OpenAI directly and spend real tokens.

The HTTP shell stays separate from autonomy semantics: `src/routes/autonomyRoutes.ts` owns signed autonomy admission, continuation, and abort; the `src/lib/autonomy*.ts` modules separately own fencing, transport, exhaustive traversal, orchestration, investigation, reduction, evidence, finalization, and artifact persistence. The public HTTP surface is:

- `GET /health`;
- `POST /v1/operations-briefs`, authenticated with the brief-ingress HMAC context;
- `POST /v1/operations-copilot/turns`, authenticated with the copilot-ingress HMAC context;
- `POST /v1/operations-autonomy-runs`, authenticated with the autonomy-ingress HMAC context;
- `POST /v1/operations-episodes`, authenticated with the episode-ingress HMAC context;
- `POST /v1/operations-autonomy-runs/:runId/continue`, for a backend-owned durable work item;
- `POST /v1/operations-autonomy-runs/:runId/abort`, which durably revokes admission before aborting agent work;
- `GET|HEAD /v1/operations-brief-runs/:instanceId`, with a short-lived route-bound read ticket;
- `GET|HEAD /v1/operations-copilot/conversations/:instanceId`, with a short-lived route-bound read ticket;
- `GET|HEAD /v1/operations-autonomy-runs/:runId`, with a short-lived route-bound read ticket.

Browser routes are read-only. They do not accept sends, attachments, aborts, SSE, or other mutations. Live reads use Flue long polling and resume from the last native offset. History responses are bounded before native serialization and expose a signed route-bound `Intelligence-History-Before` cursor when older sanitized messages exist. The Ops client can page backward without disturbing the live head.

The public projection removes hidden messages, metadata, files, reasoning content, private data parts, and raw tool arguments, results, and errors. Copilot user and assistant text remains visible because the conversation is subject-private. Brief and autopilot model prose stays private; their public streams contain only schema-bound lifecycle events. Convex callbacks and run state are authoritative for their results and terminal status.

## Environment

The Worker requires:

- `OPENAI_API_KEY`, the encrypted Worker secret used by Flue's OpenAI Responses provider;
- `OPERATIONS_AUTONOMY_ADMISSION_FENCE`, the run-keyed admission-fence Durable Object namespace;
- `INTELLIGENCE_INGRESS_SECRET`, for signed brief, copilot, autonomy, continuation, and abort ingress;
- `INTELLIGENCE_CALLBACK_SECRET`, for callbacks and recommendation proposals;
- `INTELLIGENCE_READ_SECRET`, independently revocable signing for reads and autonomy work authorization;
- `INTELLIGENCE_STREAM_SECRET`, for short-lived browser stream tickets and private history cursors;
- `CONVEX_INTELLIGENCE_CALLBACK_URL`;
- `CONVEX_INTELLIGENCE_READ_URL`;
- `CONVEX_INTELLIGENCE_RECOMMENDATION_URL`;
- `CONVEX_INTELLIGENCE_EPISODE_READ_URL`;
- `CONVEX_INTELLIGENCE_EPISODE_CALLBACK_URL`;
- `CONVEX_INTELLIGENCE_AUTONOMY_CALLBACK_URL`;
- `CONVEX_INTELLIGENCE_AUTONOMY_READ_URL`;
- `CONVEX_INTELLIGENCE_AUTONOMY_WORK_URL`;
- `CONVEX_INTELLIGENCE_AUTONOMY_RECOMMENDATION_URL`;
- `CONVEX_INTELLIGENCE_AUTONOMY_RECOMMENDATION_EVIDENCE_URL`;
- `OPS_ORIGIN`, the exact HTTPS operations-dashboard origin (local HTTP is allowed only on localhost).

Flue sends model work directly to the pinned OpenAI Responses model. Interrupted semantic work remains durable and can continue in a new submission while authority is current.

Keep staging and production values separate. Secrets belong in Wrangler secret storage, not committed environment files:

```sh
pnpm exec wrangler secret put OPENAI_API_KEY --env staging
pnpm exec wrangler secret put INTELLIGENCE_STREAM_SECRET --env staging
```

## Checks

```sh
pnpm --filter @code2create/intelligence lint
pnpm --filter @code2create/intelligence typecheck
pnpm --filter @code2create/intelligence test
pnpm --filter @code2create/intelligence build
pnpm --filter @code2create/intelligence deploy:check
```

The ordinary test suite includes deterministic autonomy boundary evaluations. They use a signed fake backend and scripted receipts, so they spend no model tokens. The live model evaluation is separate:

```sh
pnpm --filter @code2create/intelligence eval
```

## Evaluation

The deterministic autonomy suite exercises the production signing and transport contracts, work authorization after local context restoration, cursor-paged evidence, later-page recommendation provenance, lost-response replay after later work, citation-splice rejection, and HMAC domain separation. Backend tests separately exercise the real Convex read and recommendation mutations. Unit and fault-injection tests cover cursor cycles, snapshot drift, cold continuation, candidate ownership, sanitized history paging, and admission-fence races.

The live brief evaluation runs the real brief agent, instructions, pinned OpenAI model, and publish tool against frozen health snapshots. It checks exact publication, grounded citations, empty-source handling, and prompt-injection resistance. It requires `OPENAI_API_KEY` and spends tokens.

## Deployment

Cloudflare Workers Builds deploys the staging Worker from repository branch `staging`, root directory `apps/intelligence`, build command `pnpm cloudflare:build:staging`, and deploy command `pnpm cloudflare:deploy:staging`. Non-production branch builds stay disabled. The checked-in command derives the release identity from Cloudflare's commit metadata; the Worker connection owns the branch boundary.

For an authorized local recovery deployment:

```sh
CLOUDFLARE_ENV=staging VITE_RELEASE_ID="$(git rev-parse HEAD)" \
  pnpm --filter @code2create/intelligence deploy:built
```

Do not deploy production from an unreviewed working tree. Configure the corresponding Convex URLs, HMAC secrets, Durable Object migration, and exact Ops origin before dispatching real work.

## Framework documentation

- [Cloudflare target](https://flueframework.com/docs/guide/cloudflare-target/)
- [Agent API](https://flueframework.com/docs/reference/agent-api/)
- [Routing](https://flueframework.com/docs/guide/routing/)
- [Tools](https://flueframework.com/docs/guide/tools/)

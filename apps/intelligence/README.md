# Code2Create intelligence Worker

This is the private Flue Worker for bounded, durable intelligence jobs. Convex owns all event state. The Worker receives a frozen, redacted projection, prepares one constrained result, and signs its callback to Convex. It has no participant, admission, queue, attendance, review, score, access, or incident command.

The first shipped job is an operator-requested operations brief. One brief ID creates one Durable Object agent instance, so a retried signed dispatch cannot create a second model run. The result can contain at most three priorities and must cite the source health signals. Convex validates the cited keys, severity, owner, next action, source checksum, and first-settlement rule before publishing it.

## Local development

Install from the workspace root:

```sh
pnpm install --frozen-lockfile
```

Run the Worker:

```sh
pnpm dev:intelligence
```

The repository-root `pnpm dev` command also configures the matching local Convex HMAC values and callback URL. This makes the operations brief runnable from the local operations dashboard. Copy `.dev.vars.example` to `.dev.vars` and put a real OpenAI key in it; the model call is a real remote call during local development and spends real tokens.

The only HTTP routes are:

- `GET /health`
- `POST /v1/operations-briefs`, authenticated with the service HMAC protocol

There is deliberately no public agent or chat route.

The Worker needs these environment bindings:

- `OPENAI_API_KEY`, the credential for the agent's model, `openai/gpt-5.6-luna`;
- `INTELLIGENCE_INGRESS_SECRET`, shared only with the matching Convex deployment;
- `INTELLIGENCE_CALLBACK_SECRET`, shared only with the matching Convex deployment;
- `CONVEX_INTELLIGENCE_CALLBACK_URL`, the matching Convex HTTP callback.

`nodejs_compat` exposes the Worker's bindings as `process.env`, which is where the Flue runtime's OpenAI provider resolves its credential. Nothing in the application reads the key.

Keep staging and production values separate. Secrets belong in Wrangler secret storage, not `.env` files committed to the repository:

```sh
pnpm exec wrangler secret put OPENAI_API_KEY --env staging
```

## Checks

```sh
pnpm --filter @code2create/intelligence lint
pnpm --filter @code2create/intelligence typecheck
pnpm --filter @code2create/intelligence test
pnpm --filter @code2create/intelligence build
pnpm exec wrangler deploy --env staging --strict --dry-run
```

These stay offline. The live evaluation is separate because it spends tokens:

```sh
pnpm --filter @code2create/intelligence eval
```

## Evaluation

`src/evals/` runs the real agent — real instructions, real model, real publish tool — against frozen health snapshots and scores the signed callback it delivers. Each case runs several times and every run must pass, so an intermittent contract violation fails rather than averages away.

The suite checks that the agent publishes exactly once and never answers in prose, cites only signal keys the snapshot carries, copies each priority's severity, owner, and next action from a cited signal, keeps at most three non-overlapping priorities, publishes an empty brief for an empty snapshot, invents no person, team, deadline, metric, or incident, and treats an instruction-shaped signal detail as evidence rather than as an instruction. Every rule reads the parsed callback payload; none compares a model-written sentence to an expected sentence.

The suite reads `OPENAI_API_KEY` from the repository-root `.env.local`, and skips with a message when the key is absent.

## Deployment

Build once and deploy the exact output through the protected release workflow. For a manual staging check:

```sh
CLOUDFLARE_ENV=staging VITE_RELEASE_ID="$(git rev-parse HEAD)" \
  pnpm --filter @code2create/intelligence deploy:built
```

Do not deploy production from an unreviewed working tree. Configure the corresponding Convex URL and HMAC secrets before dispatching a real brief.

## Framework documentation

- [Cloudflare target](https://flueframework.com/docs/guide/cloudflare-target/)
- [Agent API](https://flueframework.com/docs/reference/agent-api/)
- [Routing](https://flueframework.com/docs/guide/routing/)
- [Tools](https://flueframework.com/docs/guide/tools/)

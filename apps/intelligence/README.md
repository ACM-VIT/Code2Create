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

The repository-root `pnpm dev` command also configures the matching local Convex HMAC values and callback URL. This makes the operations brief runnable from the local operations dashboard. The Workers AI binding remains a real remote binding during local development and can incur Cloudflare usage.

The only HTTP routes are:

- `GET /health`
- `POST /v1/operations-briefs`, authenticated with the service HMAC protocol

There is deliberately no public agent or chat route.

The Worker needs these environment bindings:

- `AI`, the Cloudflare Workers AI binding;
- `INTELLIGENCE_INGRESS_SECRET`, shared only with the matching Convex deployment;
- `INTELLIGENCE_CALLBACK_SECRET`, shared only with the matching Convex deployment;
- `CONVEX_INTELLIGENCE_CALLBACK_URL`, the matching Convex HTTP callback.

Keep staging and production values separate. Secrets belong in Wrangler secret storage, not `.env` files committed to the repository.

## Checks

```sh
pnpm --filter @code2create/intelligence lint
pnpm --filter @code2create/intelligence typecheck
pnpm --filter @code2create/intelligence test
pnpm --filter @code2create/intelligence build
pnpm exec wrangler deploy --env staging --strict --dry-run
```

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

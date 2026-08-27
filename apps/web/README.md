# Code2Create participant portal

The participant-facing Vite application for profile setup, teams, project intake, admission status, event check-ins, queues, integrations, and support.

## Development

Run the complete local product from the repository root:

```sh
pnpm dev
```

The tracked `.env.development` connects this app to the local Convex deployment. To run only this client against an already-running backend:

```sh
pnpm --filter @code2create/web dev
```

## Checks

```sh
pnpm --filter @code2create/web lint
pnpm --filter @code2create/web typecheck
pnpm --filter @code2create/web test
pnpm --filter @code2create/web build
```

## Deployment

Cloudflare Workers Builds deploys this application from its own Worker connection. The staging Worker uses repository branch `staging`, root directory `apps/web`, build command `pnpm cloudflare:build:staging`, and deploy command `pnpm cloudflare:deploy:staging`. Non-production branch builds stay disabled. `.env.example` documents the additional browser build values; local development does not use that template.

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

The protected `Deploy web surfaces` workflow builds and deploys the participant portal, operations dashboard, handbook, and intelligence Worker from one commit. `.env.example` documents the release variables; local development does not use that template.

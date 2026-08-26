# Code2Create operations

The permission-scoped Vite work application for admissions, event setup, attendance, hall operations, judging, support, access, integrations, rehearsals, and incident recovery.

Navigation and actions come from the current person's exact grants. A role label alone does not open a route or authorize a command.

## Development

Run the complete local product from the repository root:

```sh
pnpm dev
```

The tracked `.env.development` connects this app to the local Convex deployment. To run only this client against an already-running backend:

```sh
pnpm --filter @code2create/ops dev
```

## Checks

```sh
pnpm --filter @code2create/ops lint
pnpm --filter @code2create/ops typecheck
pnpm --filter @code2create/ops test
pnpm --filter @code2create/ops build
```

## Deployment

The protected `Deploy web surfaces` workflow builds and deploys all web surfaces from one commit. `.env.example` documents the release variables; local development does not use that template.

# Code2Create handbook

This Vite application renders the internal Markdown handbook on Cloudflare. It uses Google identity and the exact event-scoped `handbook.read` permission.

The browser bundle does not contain handbook Markdown. The separate backend serves documents generated from `README.md` and `specs/*.md`.

## Development

Run the local product from the repository root:

```sh
pnpm dev
```

The tracked `.env.development` connects this application to local Convex. To run only this application against an active backend:

```sh
pnpm --filter @code2create/handbook dev
```

## Checks

```sh
pnpm --filter @code2create/handbook lint
pnpm --filter @code2create/handbook typecheck
pnpm --filter @code2create/handbook build
```

The release build regenerates the backend handbook module before building the client.

## Deployment

The protected `Deploy web surfaces` workflow builds and deploys all web surfaces from one commit. `.env.example` lists release variables.

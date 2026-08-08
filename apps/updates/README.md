# Code2Create update service

A Cloudflare Worker and R2-backed Expo Updates protocol server for the reviewer app.

The Worker serves signed manifests, signed rollback directives, and immutable content-addressed assets. The update private key never leaves the release machine. A publisher uploads every asset first, registers an immutable release, and conditionally advances the runtime pointer last. If another release advances the pointer during an export, activation returns a conflict instead of overwriting it.

## Cloudflare setup

Create one bucket per environment, set a different random admin token in each Worker environment, then deploy.

```sh
pnpm --filter @code2create/updates bucket:create:staging
pnpm --filter @code2create/updates bucket:create:production

pnpm --filter @code2create/updates configure:staging
pnpm --filter @code2create/updates configure:production

pnpm --filter @code2create/updates deploy:staging
pnpm --filter @code2create/updates deploy:production
```

The configure commands generate a different 48-byte token in each ignored environment file, set the file to owner-only access, and pipe the same value to Wrangler without printing it. A failed Cloudflare call leaves the local token in place so a retry converges on the same value.

Cloudflare commands use an explicit `CLOUDFLARE_API_TOKEN` when present. Otherwise they refresh the authenticated `cf` CLI session and pass its access token to the Wrangler child process in memory. The repository does not copy that Cloudflare credential into an environment file.

Current endpoints:

- staging: `https://code2create-updates-staging.acmvit.workers.dev/manifest`
- production: `https://code2create-updates.acmvit.workers.dev/manifest`

Use the deployed Worker or its custom domain as `C2C_UPDATES_URL`, including `/manifest`. For each environment, the reviewer app's `.env.<environment>.local` is the single source for that URL. Add the private-key path to `apps/updates/.env.<environment>.local`, and put the URL and native identifiers/build values in `apps/reviewer/.env.<environment>.local`. Staging and production commands load only their matching files; explicit shell variables may be used instead.

The current local signing key is under `/Users/ishaan/.config/code2create/updates/`; only `apps/reviewer/certs/certificate.pem` belongs in source control. Back up the private key in the event secret store before the first production binary is distributed. Losing it means existing binaries can no longer trust a newly signed update.

## Release order

Before distributing the first binary for a runtime, publish a signed rollback pointer so an embedded-only client gets a valid response:

```sh
pnpm --filter @code2create/updates rollback:staging
pnpm --filter @code2create/updates rollback:production
```

Build and test the signed binary against that environment. Publish JavaScript only from a clean committed tree:

```sh
pnpm --filter @code2create/updates publish:staging
pnpm --filter @code2create/updates publish:production
```

The default update release ID is the Git commit. A successful activation writes a non-secret receipt under `outputs/updates/`. Re-running the same release is idempotent. To retry a named rollback, set `C2C_UPDATE_RELEASE_ID` to its previously printed ID.

Before reading or uploading release state, the publisher calls `/health` and checks that the endpoint's channel matches the selected command. A production command pointed at the staging Worker, or the reverse, stops before export.

`rollback:*` returns the fleet to the binary's embedded bundle. To restore an earlier over-the-air version instead, revert or reapply that code in a new commit and publish it as a new release; an old manifest is never made artificially newer.

## Checks

```sh
pnpm --filter @code2create/updates lint
pnpm --filter @code2create/updates typecheck
pnpm --filter @code2create/updates test
```

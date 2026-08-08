# Staging browser verification

This package checks the deployed participant and operations surfaces. It never creates accounts or bypasses Google sign-in.

The protected `Staging release verification` workflow first asks the staging Convex deployment to verify two existing accounts:

- one eligible participant with a complete current profile, an active team membership, and exact profile/team read grants;
- one operations account with active event-scoped `operations.health.read` and `rehearsal.read` grants.

The check uses an internal Convex query and a deployment-scoped key. The staging Convex environment must set `C2C_DEPLOYMENT_ENVIRONMENT=staging`. A role label does not satisfy a missing grant.

## Create the browser states

Sign in through the real staging Google flow and save each browser state outside the repository:

```sh
pnpm --filter @code2create/e2e exec playwright codegen \
  --save-storage=/absolute/private/path/participant.json \
  https://participant-staging.example.org

pnpm --filter @code2create/e2e exec playwright codegen \
  --save-storage=/absolute/private/path/operations.json \
  https://operations-staging.example.org/health
```

Close each Playwright window only after the expected signed-in surface appears. Base64-encode each JSON file and store it in the protected `staging` GitHub Environment. Do not commit, upload as an artifact, or print either file.

Required protected variables:

- `EVENT_SLUG`
- `PARTICIPANT_SITE_URL`
- `OPERATIONS_SITE_URL`
- `RELEASE_PARTICIPANT_EMAIL`
- `RELEASE_OPERATIONS_EMAIL`

Required protected secrets:

- `CONVEX_DEPLOY_KEY` for the staging deployment only
- `RELEASE_PARTICIPANT_STORAGE_STATE_BASE64`
- `RELEASE_OPERATIONS_STORAGE_STATE_BASE64`

The provider job in the same workflow uses separate synthetic OpenAI, GitHub, Figma, and intelligence Worker fixtures. It does not use participant project text.

Run the browser suite locally only against staging:

```sh
pnpm test:e2e:release
```

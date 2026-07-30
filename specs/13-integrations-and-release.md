# Integrations and release

## 1. Integration rule

GitHub and Figma record progress evidence. They do not calculate effort, originality, technical quality, or score.

Every reviewer-facing snapshot shows:

- provider and connected resource;
- capture time;
- last provider update time;
- previous checkpoint;
- connection/staleness warning;
- the small set of recorded facts.

A missing or stale integration remains visible. The review continues with live/manual evidence.

## 2. GitHub App

### Permissions

Register a Code2Create GitHub App with:

- **Metadata: read**;
- **Contents: read**.

Subscribe only to:

- `push`;
- `installation`;
- `installation_repositories`.

Do not request:

- Contents write;
- Administration;
- Actions;
- Issues or pull requests;
- Secrets;
- Members;
- user email;
- organisation-wide access.

The team chooses **Only select repositories** during installation and selects one primary repository for the project.

### GitHub connection

1. Team lead selects **Connect GitHub**.
2. The portal creates a signed setup intent bound to event/team/person.
3. GitHub opens the App installation flow.
4. The callback validates state and installation ownership.
5. The portal lists only repositories granted to that installation.
6. Team lead selects one repository, one tracked branch, and an optional project root path.
7. The backend stores installation ID, repository ID, default branch, tracked branch, name, and permission set.
8. A baseline snapshot is captured.

The application never asks a participant to paste a personal access token.

### Authentication

The backend signs a short-lived GitHub App JWT with the private key and exchanges it for an installation access token. The token is limited to the selected repository and read permission.

Installation access tokens expire after one hour. Mint them when a provider action starts and discard them after the call. Store only the installation and repository IDs.

### Webhooks

The Convex HTTP action:

1. reads the raw body;
2. validates `X-Hub-Signature-256`;
3. checks event type and installation/repository ID;
4. deduplicates `X-GitHub-Delivery`;
5. writes a sanitised provider event;
6. schedules snapshot work;
7. returns quickly.

An invalid signature, unknown repository, duplicate delivery, or payload above supported size does not change project data.

### Snapshots

Capture at:

- connection;
- before each review window;
- review start when the existing snapshot is stale and rate budget permits;
- round close;
- participant/manual refresh.

For the tracked branch and optional root path, record:

- head commit SHA and commit time;
- number of commits since the previous checkpoint;
- provider author IDs/logins seen in those commits;
- additions, deletions, and changed-file count;
- top changed paths after root-path filtering;
- force-push, branch deletion, default-branch, or repository-access warning;
- previous snapshot ID.

Do not store source file contents, diffs, commit messages containing secrets, email addresses, or a clone of the repository.

Line and commit counts are context only. Generated files, squashes, pair programming, and branch strategy make them poor scoring measures. The baseline time and any late connection are shown beside the snapshot.

### GitHub failure and revocation

- Installation removal marks the connection revoked and stops jobs.
- Repository access removal marks it inaccessible.
- Rename/transfer is resolved by repository ID on the next refresh.
- A force push records the new head and a discontinuity flag.
- A deleted tracked branch marks the snapshot stale until the team selects another branch.
- API rate limits schedule the job for later; review context shows the last successful capture.
- A team can reconnect before the integration freeze. Reconnection creates a new connection record and keeps earlier snapshots.

## 3. Figma OAuth

### Scopes

Request:

- `file_metadata:read`;
- `file_versions:read`.

Do not request `projects:read`, `file_content:read`, comments, variables, webhooks, or write scopes in the baseline.

The portal asks the team to paste a Figma file URL. This avoids broad project listing and its extra scope/approval. The backend parses the file key and verifies access with `GET /v1/files/:key/meta`.

### Figma connection

1. Team member selects **Connect Figma**.
2. The backend creates a signed OAuth intent bound to event/team/person.
3. Figma OAuth returns to an exact environment callback URL.
4. The backend exchanges the code and encrypts the access/refresh tokens with the current token key.
5. The participant pastes a file URL.
6. The backend fetches metadata, confirms access, and shows name/role/last-touched time.
7. Team lead confirms it as the project file.
8. A baseline snapshot is captured.

If Figma requires app review for the chosen public/private distribution, submit the OAuth app early enough for staging and production approval.

### Checkpoints

At each project checkpoint, ask the team to create a named Figma version. The backend records:

- file key and name;
- current file version;
- last touched time;
- named versions created since the previous snapshot;
- captured time;
- previous snapshot ID.

The pre-round worker spreads calls over the preparation window and respects per-token/app/plan rate limits. Review start uses the newest successful snapshot and triggers a refresh only when allowed. A provider request never delays the review-start transaction.

### Why polling instead of file webhooks

Figma file webhooks are a poor default for this event:

- creating one needs `webhooks:write`;
- file-level creation requires edit permission;
- Professional plans allow 150 file webhooks, while the event may have 200–330 teams;
- `FILE_VERSION_UPDATE` fires for a named version, not every autosave.

Checkpoint polling with metadata/version scopes uses less access and works for the expected team count.

### Figma failure and revocation

- Expired/invalid tokens mark the connection `reauth_required`.
- File permission loss marks it `inaccessible`.
- Rate-limit response schedules a later attempt.
- Team can reconnect and select the same or a replacement file before freeze.
- Disconnect deletes usable tokens but keeps historical snapshots for review/audit under retention policy.

## 4. Google and Better Auth setup

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
- session and role revocation test;
- auth-intent nonce consumed once.

The VIT domain list comes from event configuration after VIT IT confirms it.

## 5. Expo notifications

### Registration

At device check:

- request permission;
- obtain Expo push token;
- upsert token against installation ID;
- remove the same token from an old/replaced device;
- send a test notification in staging/training;
- report permission/token failure to clock-in.

### Send

An accepted page mutation creates the page and a `push_send` job. The action sends a payload containing page ID, event ID, route, and generic alert text.

Do not include team project text, score, phone number, or private reason.

### Ticket and receipt

- Store Expo ticket ID.
- Fetch provider receipt after the documented delay.
- Disable tokens with terminal device errors.
- Retry transient provider/network errors with a cap.
- Keep reviewer acknowledgement separate from provider delivery.

The 90-second page deadline is based on the page record, not the push ticket.

## 6. Export bucket

The selected baseline is a private AWS S3 bucket in Mumbai (`ap-south-1`) after data-policy approval.

Configuration:

- public access blocked;
- bucket versioning on;
- server-side encryption with a dedicated KMS key;
- event-specific prefix;
- deployment credential can write/list only that prefix;
- audit/backup readers are separate roles;
- lifecycle expiry matches approved retention;
- object checksum and application manifest retained.

Round export layout:

```text
events/{eventId}/rounds/{roundId}/{timestamp}/
  manifest.json
  teams.csv
  reviews.csv
  scorecards.csv
  audit.jsonl
  manual-records.jsonl
  checksum.sha256
```

Convex backup ZIP files use a separate `backups/` prefix. Restore access is not held by the running application.

If VIT policy requires another provider/region, replace this decision before production registration data exists.

## 7. Environment matrix

| Item | Development | Staging | Production |
| --- | --- | --- | --- |
| Web | local/preview | protected staging domain | event domain |
| Convex | developer deployment | rehearsal deployment | production deployment |
| Better Auth | dev secret/clients | staging secret/clients | production secret/clients |
| Reviewer app | dev build/scheme | preview build/channel | production build/channel |
| GitHub | dev App | staging App/test repos | production App/team repos |
| Figma | dev callback/test files | staging callback/test files | approved production callback |
| Push | test devices | reviewer training devices | registered event devices |
| S3 | local/test bucket | staging prefix | production event prefix |
| Sentry | development | staging | production |

No callback URL, provider key, auth secret, user record, or push token is shared across staging and production.

## 8. CI

Pull requests run:

1. dependency lockfile check;
2. formatting, lint, and TypeScript;
3. domain/unit tests;
4. Convex schema/function tests;
5. Next.js build;
6. Expo export/config validation;
7. Playwright against an isolated seeded deployment;
8. provider webhook fixture tests;
9. secret scan.

Main-branch release candidates also run:

- signed Expo staging build when native inputs changed;
- Maestro smoke suite on at least Android and iOS;
- database migration/backfill check;
- load smoke test;
- staging auth/integration health checks.

CI logs must not print environment values, cookies, webhook bodies, or provider responses containing tokens.

## 9. Production release

### Before event freeze

1. Deploy additive Convex schema/functions to staging.
2. Run any backfill and verify counts.
3. Deploy Vercel staging and reviewer preview build/update.
4. Run auth, one-review, integration, push, export, and incident smoke tests.
5. Publish the production reviewer build and install it on reviewer devices.
6. Set the minimum build only after installation/training is complete.

### Production promotion

1. Take a production backup and record current release IDs.
2. Deploy backward-compatible Convex functions.
3. Run protected production smoke queries with synthetic/admin test records.
4. Create a staged Vercel production deployment and run route/auth checks.
5. Promote the tested Vercel deployment.
6. Publish a compatible EAS update only if needed and test a small device group first.
7. Verify GitHub/Figma callbacks, one test push, export bucket write, Sentry release, and dashboard release IDs.
8. Record the release in event configuration.

Do not change native dependencies, auth callback shape, rubric calculation, or destructive schema during a live round.

## 10. Compatibility and migrations

- Schema changes are additive through the event.
- New required fields start optional, receive a backfill, then become required in code after verification.
- A backend function supports the installed reviewer runtime until the minimum-build change is complete.
- Every EAS Update has a runtime version compatible with the installed native build.
- Changing a native dependency creates a new runtime/build.
- Event/rubric/panel configuration is versioned; a code deploy does not rewrite an active round’s configuration.

## 11. Rollback

### Web

Move the production domain back to the last verified Vercel deployment. Confirm its environment and backend compatibility.

### Reviewer update

Roll back to the previous EAS Update on the same runtime. A native-runtime problem requires the prepared previous signed build or spare devices.

### Convex functions

Redeploy the last compatible source commit. Additive schema changes stay in place. Do not restore the database for an ordinary code defect.

### Data

Use protected repair mutations for a small known error. Use backup restore only for a confirmed broad data incident under the rehearsed destructive-restore procedure.

### Auth/provider configuration

Restore the recorded previous secret/config version only if it is still secure. Never roll back to a compromised credential.

Every rollback records owner, reason, affected release IDs, start/end time, and verification result.

## 12. Secret rotation

Before launch, rehearse rotation for:

- Better Auth secret;
- Google client secret;
- GitHub App private key and webhook secret;
- Figma client secret;
- token-encryption key;
- Expo server credential;
- S3 application credential;
- Sentry auth token.

Token-encryption key rotation keeps the previous decrypt key until all active Figma credentials are re-encrypted. Webhook-secret rotation may require an overlap or coordinated provider update.

## 13. Release acceptance

- Production auth callbacks accept only production origins/schemes.
- GitHub App permission screen contains no write/admin permission.
- Invalid or repeated GitHub webhook deliveries do not create snapshots twice.
- Figma works with metadata/version scopes and does not fetch full document content.
- Provider rate limits leave a clear stale snapshot instead of blocking a review.
- Push ticket, receipt, reviewer acknowledgement, expiry, and fallback remain distinct.
- A compatible web/backend/mobile release survives rollback rehearsal.
- Round export reaches the private bucket with matching checksum and no provider credential.
- A production bundle/secret scan finds no private credential.

## References

- [GitHub App permissions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app)
- [GitHub installation access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)
- [GitHub webhook signature validation](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)
- [Figma OAuth scopes](https://developers.figma.com/docs/rest-api/scopes/)
- [Figma file metadata](https://developers.figma.com/docs/rest-api/file-endpoints/)
- [Figma version history](https://developers.figma.com/docs/rest-api/version-history-endpoints/)
- [Figma webhook limits and permissions](https://developers.figma.com/docs/rest-api/webhooks/)
- [Figma rate limits](https://developers.figma.com/docs/rest-api/rate-limits/)
- [Expo notification tickets and receipts](https://docs.expo.dev/push-notifications/sending-notifications/)
- [Expo runtime versions](https://docs.expo.dev/eas-update/runtime-versions/)
- [Vercel deployment promotion and rollback](https://vercel.com/docs/deployments/promoting-a-deployment)

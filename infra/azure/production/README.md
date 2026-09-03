# Azure production backend release gate

The production portal is `https://c2c.sh`. The operations surface is
`https://ops.c2c.sh`. Both use the production backend origins below. Creating
the infrastructure or deploying a Worker must not create an event or change an
event's application state. Applications remain closed until a Supreme operator
explicitly opens the relevant participant windows from Event setup.

Production uses one active self-hosted Convex backend in the same Azure region
and private VNet as Azure Database for PostgreSQL Flexible Server. Do not put two
independent Convex backends behind a load balancer. The supported unit is one
authoritative backend, a highly available managed database, restorable object
and module storage, and a rehearsed VM replacement.

Do not copy the staging VM size into production. Production keeps the validated
compute, PostgreSQL tier, connection limits, and provider budgets recorded in
this inventory.

## Required topology

- one pinned Convex backend image with Node.js 20, 22, or 24;
- one private PostgreSQL Flexible Server with zone-redundant high availability,
  point-in-time restore, and deletion protection;
- one production-only VNet, subnet, managed identity, and Key Vault;
- no public PostgreSQL, Convex dashboard, Docker socket, or SSH listener;
- Cloudflare-proxied `realtime.c2c.sh` and `api.c2c.sh` origins with the backend
  accepting HTTPS traffic only from Cloudflare's published ranges;
- a separate production deployment secret inventory; and
- automated database backup verification plus a timed restore rehearsal into an
  isolated environment.

Participant phone verification uses AWS End User Messaging SMS in Mumbai. The
sender IAM identity may perform only `sms-voice:SendTextMessage`. Production
must not open registration until the AWS account is out of the SMS sandbox and
either the intended international route has been exercised or the India sender
ID, entity ID, and exact DLT template are approved and configured.

## Provisioned inventory

- resource group: `rg-code2create-production` in Central India;
- VNet: `vnet-c2c-production` (`10.43.0.0/16`);
- application subnet: `snet-app` (`10.43.1.0/24`);
- PostgreSQL subnet: `snet-postgres` (`10.43.2.0/24`);
- application public IP: `20.204.40.131`;
- Key Vault: `kv-c2c-prod-b88416`;
- Log Analytics: `log-c2c-production`, with all PostgreSQL diagnostic logs and
  metrics retained for 30 days, plus VM performance, warning-level syslog, and
  filtered container warning/error records collected by Azure Monitor Agent;
- VM monitoring: `dce-c2c-production`, `dcr-c2c-production-vm`, managed boot
  diagnostics, and the `C2CContainerLog_CL` Log Analytics table;
- PostgreSQL: `pg-c2c-prod-b88416`, PostgreSQL 17, private General Purpose
  `Standard_D8ds_v5`, 128 GiB Premium storage with auto-grow, 35-day backups,
  geo-redundant backup, zone-redundant high availability, and the
  `code2create_production` Convex database; and
- application VM: `vm-c2c-production-app`, `Standard_D32as_v5`.

The VM was resized from `Standard_D8as_v5` after production-shaped traffic
showed that eight vCPUs did not leave enough headroom and the 16-vCPU shape
saturated during a large intake burst while PostgreSQL retained headroom. Keep
the validated 32-vCPU shape unless a separately reviewed infrastructure change
replaces it.

The backend write ceiling is 16 MiB/s. Convex's self-hosted 4 MiB/s default is
too low for this schema's event bootstrap and novelty-corpus publication. Keep
the configured ceiling in the production runtime.

The backend container has a 65,536 soft and hard `nofile` limit. Docker's
1,024-file default leaves only about 992 descriptors for realtime clients and
causes a hard connection cliff before the database or VM is saturated. Keep the
limit in both the production Compose service and the isolated rehearsal runner.
The backend and Caddy JSON logs rotate at 25 MiB and retain five files per
container. Keep those limits in Compose so verbose application logs cannot fill
the VM OS disk.

The Convex backend stores durable database state in PostgreSQL and file/module
state in these private R2 buckets:

- `code2create-convex-production-exports`;
- `code2create-convex-production-imports`;
- `code2create-convex-production-modules`;
- `code2create-convex-production-files`; and
- `code2create-convex-production-search`.

The exports bucket has a 35-day retention lock. A backup is not considered
verified merely because an export object exists: the recovery rehearsal must
still import it into the isolated rehearsal deployment and compare inventories.

The VM identity reads `postgres-app-password`, `convex-instance-secret`,
`r2-access-key-id`, and `r2-secret-access-key` from the production Key Vault.
The R2 credentials must be a production-only token scoped to the five buckets.
Do not reuse the interactive Wrangler or staging credentials.

After the backend is healthy, generate its CLI key inside the container, store
it as `convex-admin-key`, then run `configure-convex-environment.sh` followed by
`deploy-convex.sh`. Both scripts select the self-hosted production deployment
explicitly. Environment configuration grants one bootstrap email permission to
create the event; it does not create the event or open either application
window.

The production `posthog-project-token` is stored in the production Key Vault.
Convex and the intelligence Worker use it with the first-party
`https://i.c2c.sh` ingest proxy. To refresh only the Convex PostHog values, run
`infra/azure/configure-posthog-environment.sh production`; the command never
prints the token.

Normal function releases use `.github/workflows/backend-deploy.yml`. Production
deployment is an explicit workflow run from `main`; it does not run on a push.
The production GitHub environment authenticates to Azure with OIDC, can read
only the production Key Vault secrets allowed by its role, and passes the exact
Git revision to `deploy-convex.sh`. No Azure client secret or Convex admin key is
stored in GitHub. Environment configuration remains a separate operator action
and is not part of an ordinary code deployment.

External-participant email sign-in uses the production Cloudflare Email
Sending identity. Before running `configure-convex-environment.sh`, store
`cloudflare-email-account-id`, `cloudflare-email-api-token`, and
`cloudflare-email-from` in the production Key Vault. The API token must be
limited to Email Sending, and the from address must belong to the verified
production sending domain. The portal advertises email sign-in only when all
three values are present.

The D32 backend admits 512 concurrent queries, 256 mutations, and 100 Node or V8
actions. The intake workpool uses at most 32 Node actions at a time. Draft
embedding uses the separate V8 action pool, so background novelty indexing
cannot take the participant-facing question slots. Keep these production limits
together so background indexing cannot consume participant-facing capacity.

Only ports 80 and 443 accept inbound traffic, and only from Cloudflare's
published IPv4 proxy ranges. SSH is not an operational path; use Azure Run
Command for host maintenance. The Convex dashboard is intentionally absent from
the production Compose file.

Azure Monitor alerts the technical-director action group when the VM or
PostgreSQL becomes unavailable, PostgreSQL CPU remains above 80%, PostgreSQL
storage exceeds 80%, VM CPU remains above 80%, VM available memory falls below
15%, VM OS-disk IOPS or bandwidth exceeds 80%, the VM root filesystem exceeds
80%, containers emit repeated errors, or the VM heartbeat disappears. These
alerts supplement the application-level release and operations-health checks;
they do not replace them. Run `configure-observability.sh` after provisioning a
replacement production VM.

## DNS and release order

1. Point proxied `realtime.c2c.sh` and `api.c2c.sh` A records at
   `20.204.40.131` only after the backend is healthy.
2. Deploy the participant Worker with its `c2c.sh` custom domain and the
   operations Worker with its `ops.c2c.sh` custom domain.
3. Set the Google Web OAuth redirect URI to
   `https://api.c2c.sh/api/auth/callback/google` and its JavaScript origins to
   `https://c2c.sh` and `https://ops.c2c.sh`.
4. While the event is closed, import the validated participant eligibility
   lists in bounded batches. Verify the source checksums and exact VIT and
   external counts before activating the import. Import only external emails
   and VIT registration numbers. Do not derive eligibility from names or team
   rows.
5. Import and publish the reviewed novelty corpus. Verify its source checksum,
   entry count, embedding model, and embedding dimensions.
6. Verify the public state contains no event, or an event whose internal and
   external application windows are both closed.

The old wildcard `*.c2c.sh` DNS records are not production routing. Remove them
when all named production records exist; do not use the wildcard as a fallback.

Cloudflare terminates the public TLS connection before proxying to Caddy. The
production Caddy configuration therefore disables the ACME TLS-ALPN challenge
and uses HTTP validation, which Cloudflare can forward to the origin.

The backend health check must verify both `node --version` and `/version`.
Deployment is incomplete until one Node-backed intake action runs through the
public production-shaped route. Pin the exact multi-architecture image digest;
never deploy `latest` without recording its resolved digest and rehearsal result.

Set `NOVELTY_GLOBAL_REQUESTS_PER_MINUTE` below the measured OpenAI project request
limit with operational headroom. Optional novelty may shed and show
**Unavailable**. Autosave, proposal submission, authentication, and the two fixed
questions may not depend on available novelty or model capacity.

Set `NOVELTY_INDEX_REQUESTS_PER_MINUTE` separately. Its reserved background
drain must fit inside the remaining OpenAI embedding budget after live-preview
headroom. A full 1,500-team save burst may drain gradually; it must not launch
1,500 provider calls at once or consume the adaptive-question Workpool.

## Release and rollback

1. Back up production and verify the restore manifest.
2. Deploy schema and functions to the isolated production-shaped rehearsal.
3. Run type checks, idea-round suites, and one real provider smoke test.
4. Deploy the exact tested backend build before the participant Worker build.
5. Verify that the active participant eligibility import has the approved
   source checksums and exact class counts.
6. Verify auth, profile, team, idea, both fixed questions, both
   generated-or-fallback question slots, novelty, final confirmation, revision,
   and organizer review.
7. Open applications only after operations health shows no stale or failed
   release gate.

Rollback uses the prior pinned backend image and compatible function bundle.
Database restore is an incident action, not a normal rollback. If a new schema
cannot run with the prior bundle, stop the release before applications open;
never improvise a destructive production restore during participant traffic.

References: [Convex self-hosting](https://github.com/get-convex/convex-backend/tree/main/self-hosted),
[Convex backend image](https://github.com/get-convex/convex-backend/blob/main/self-hosted/docker-build/Dockerfile.backend),
and [Convex limits](https://docs.convex.dev/production/state/limits).

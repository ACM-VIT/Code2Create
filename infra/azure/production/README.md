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

Do not copy the staging VM size into production. Select the production compute,
PostgreSQL tier, connection limit, and provider budgets only after the checked-in
3,000-client authenticated load run passes on the proposed production shape.

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

## Provisioned inventory

- resource group: `rg-code2create-production` in Central India;
- VNet: `vnet-c2c-production` (`10.43.0.0/16`);
- application subnet: `snet-app` (`10.43.1.0/24`);
- PostgreSQL subnet: `snet-postgres` (`10.43.2.0/24`);
- application public IP: `20.204.40.131`;
- Key Vault: `kv-c2c-prod-b88416`;
- Log Analytics: `log-c2c-production`, with all PostgreSQL diagnostic logs and
  metrics retained for 30 days;
- PostgreSQL: `pg-c2c-prod-b88416`, PostgreSQL 17, private General Purpose
  `Standard_D4ds_v5`, 128 GiB Premium storage with auto-grow, 35-day backups,
  geo-redundant backup, zone-redundant high availability, and the
  `code2create_production` Convex database; and
- proposed application VM: `vm-c2c-production-app`, `Standard_D8as_v5`.

The VM size is the proposed capacity-test shape, not an assertion that it has
passed. Resize it before opening applications if the checked-in 3,000-client run
does not leave the required headroom.

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

Only ports 80 and 443 accept inbound traffic, and only from Cloudflare's
published IPv4 proxy ranges. SSH is not an operational path; use Azure Run
Command for host maintenance. The Convex dashboard is intentionally absent from
the production Compose file.

Azure Monitor alerts the technical-director action group when the VM or
PostgreSQL becomes unavailable, PostgreSQL CPU remains above 80%, or storage
exceeds 80%. These alerts supplement the application-level release and
operations-health checks; they do not replace them.

## DNS and release order

1. Point proxied `realtime.c2c.sh` and `api.c2c.sh` A records at
   `20.204.40.131` only after the backend is healthy.
2. Deploy the participant Worker with its `c2c.sh` custom domain and the
   operations Worker with its `ops.c2c.sh` custom domain.
3. Set the Google Web OAuth redirect URI to
   `https://api.c2c.sh/api/auth/callback/google` and its JavaScript origins to
   `https://c2c.sh` and `https://ops.c2c.sh`.
4. Verify the public state contains no event, or an event whose internal and
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

## Capacity proof

Run the load driver from a separate load host against a disposable production-
shaped environment:

1. ramp 3,000 distinct authenticated clients over 60 seconds;
2. hold all subscriptions for at least two minutes;
3. run the `idea-editing` profile against a disposable `load-*` event;
4. keep 25% of eligible participants present, with one committing writer per
   active team;
5. autosave every five seconds and request novelty every fifteen seconds;
6. run the `intake-burst` profile from fresh teams through two fixed questions,
   the 32-slot adaptive queue, and review while every teammate stays subscribed;
7. verify ordinary proposal saves and final submissions during the same capacity
   window; and
8. repeat after one backend restart and one PostgreSQL failover rehearsal.

The run passes only with the thresholds in
`specs/09-delivery-and-acceptance.md`. It must also leave at least 35% backend CPU
headroom, 30% PostgreSQL connection headroom, no sustained database lock or I/O
queue, no Workpool item older than its product deadline, and no process restart
or out-of-memory event. Record the exact commit, image digest, VM and database
shape, PostgreSQL parameters, OpenAI project limits, environment configuration,
and result JSON.

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
3. Run type checks, idea-round suites, the authenticated capacity profile, and
   one real provider smoke test.
4. Deploy the exact tested backend build before the participant Worker build.
5. Verify auth, profile, team, idea, fixed questions, optional generated
   question, novelty, final confirmation, revision, and organizer review.
6. Open applications only after operations health shows no stale or failed
   release gate.

Rollback uses the prior pinned backend image and compatible function bundle.
Database restore is an incident action, not a normal rollback. If a new schema
cannot run with the prior bundle, stop the release before applications open;
never improvise a destructive production restore during participant traffic.

References: [Convex self-hosting](https://github.com/get-convex/convex-backend/tree/main/self-hosted),
[Convex backend image](https://github.com/get-convex/convex-backend/blob/main/self-hosted/docker-build/Dockerfile.backend),
and [Convex limits](https://docs.convex.dev/production/state/limits).

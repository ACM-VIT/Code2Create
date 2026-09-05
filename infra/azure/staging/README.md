# Azure staging backend

The idea-submission staging environment uses:

- one Central India VM for self-hosted Convex and Caddy;
- private Azure Database for PostgreSQL Flexible Server;
- Azure Key Vault for runtime credentials;
- Cloudflare DNS and TLS proxying for the public origins.

Azure inventory:

- resource group: `rg-code2create-staging`;
- VNet: `vnet-c2c-staging` in Central India;
- application VM: `vm-c2c-staging-app`, `Standard_D2as_v5`;
- PostgreSQL 17: `pg-c2c-stg-b88416`, private `Standard_B2s`, seven-day backups;
- Key Vault: `kv-c2c-stg-b88416`; and
- public origin IP: `104.211.94.181`.

South India was not used for staging compute because Azure reported both an
offer restriction for PostgreSQL Flexible Server and live capacity restrictions
for the tested small VM families. The subscription's vCPU quota was not the
constraint. Production placement remains a separate release decision.

Public origins:

- Convex realtime API: `https://realtime-staging.c2c.sh`
- Convex HTTP actions: `https://api-staging.c2c.sh`
- Participant portal: `https://code2create-participant-staging.acmvit.workers.dev`
- Operations: `https://code2create-operations-staging.acmvit.workers.dev`

The Convex dashboard binds only to the VM loopback interface. Reach it through an
SSH tunnel when needed:

```sh
ssh -L 6791:127.0.0.1:6791 c2cadmin@104.211.94.181
```

Then open `http://127.0.0.1:6791` and use an admin key from the staging secret
inventory. Do not expose port 6791 in the Azure network security group.

The VM system identity reads only the staging Key Vault secrets. The database
has private VNet access only and seven days of managed backups. The participant
GitHub OAuth App must be configured separately from the read-only team GitHub App.
Figma, voice, and native-push integrations remain deliberately unconfigured
until their staging registrations are approved. Before testing external email
sign-in, deploy the staging email Worker, configure one SES or Cloudflare
provider in that Worker, and set Convex `EMAIL_SERVICE_URL`,
`EMAIL_SEND_INGRESS_SECRET`, and `AUTHENTICATION_EMAIL_PROVIDER`. The HMAC must
match the Worker. The portal keeps the email option disabled until the Convex
side of that boundary is complete; verify the selected provider in staging
before opening sign-in.

Phone verification uses AWS End User Messaging SMS in `ap-south-1`. The
staging Convex environment needs `PHONE_VERIFICATION_HMAC_SECRET`,
`SMS_AWS_ACCESS_KEY_ID`, `SMS_AWS_SECRET_ACCESS_KEY`, and `SMS_AWS_REGION` from
the matching Key Vault inventory. AWS must move the account out of the SMS
sandbox before codes can be sent to unverified participant numbers. A local
India route additionally requires an approved sender ID, entity ID, and exact
message template ID.

Set `PHONE_VERIFICATION_MESSAGE_TEMPLATE` to the following value so OTP
autofill is bound to the participant Worker's exact hostname:

```text
Your Code2Create verification code is {{code}}. It expires in 10 minutes. Do not share it.

@code2create-participant-staging.acmvit.workers.dev #{{code}}
```

The participant and operations Workers were deployed manually with the Azure
origins above. Cloudflare currently reports no Git build trigger for either
Worker, so a repository push cannot replace these deployments until those
connections are deliberately created.

Server-side PostHog ingestion uses the staging `posthog-project-token` from the
staging Key Vault and the first-party `https://i.c2c.sh` ingest proxy. Apply the
two Convex values without printing the token by running:

```sh
infra/azure/configure-posthog-environment.sh staging
```

Backend functions deploy automatically after backend checks pass on a push to
the `staging` branch. `.github/workflows/backend-deploy.yml` signs in to Azure
through the staging GitHub environment's OIDC identity, reads only the staging
`convex-admin-key`, and runs `deploy-convex.sh` against
`https://realtime-staging.c2c.sh`. GitHub stores no Azure client secret or
Convex admin key.

## Remaining idea-round activation

1. Create or update the staging Google Web OAuth client.
2. Add `https://api-staging.c2c.sh/api/auth/callback/google` as its exact redirect URI.
3. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in the staging Convex environment.
4. Sign in as `technicaldirector.acmvit@gmail.com`, create the event, publish the
   participant and intake policies, publish the reviewed novelty corpus, and open
   applications.

Until those steps are complete, the public backend intentionally reports
`googleConfigured: false` and no event. The OpenAI key, embedding dimensions,
follow-up generation code, and novelty runtime are deployed; novelty remains
inactive until a reviewed corpus is published.

## Operations

Check the runtime without printing secrets:

```sh
ssh c2cadmin@104.211.94.181 \
  'cd /srv/code2create && sudo docker compose ps && sudo docker compose exec -T backend node --version'
```

The backend health check requires Node.js 20, 22, or 24 as well as the Convex
version endpoint. This is a release requirement because intake question
generation uses a Node-backed action; a backend image without Node must never
receive participant traffic.

If the operator's public IP changes, update the `AllowSshFromOperator` source on
`nsg-c2c-staging-app` before connecting. Ports 80 and 443 accept only Cloudflare's
published IPv4 proxy ranges. PostgreSQL and the Convex dashboard have no public
listener.

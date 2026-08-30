# Azure staging backend

The idea-submission staging environment uses:

- one Central India VM for self-hosted Convex and Caddy;
- private Azure Database for PostgreSQL Flexible Server;
- Azure Key Vault for runtime credentials;
- Azure Storage for operator-created staging backups; and
- Cloudflare DNS and TLS proxying for the public origins.

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
has private VNet access only and seven days of managed backups. Google OAuth and
the GitHub, Figma, email, voice, and native-push integrations remain deliberately
unconfigured until their staging registrations are approved.

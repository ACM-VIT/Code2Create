# AWS production Convex backend

The production Convex process runs on one `m7i.8xlarge` EC2 instance in
`ap-south-1`. It uses the production Azure PostgreSQL Flexible Server and
private Cloudflare R2 buckets. A point-to-point WireGuard link
through the Azure production VNet keeps PostgreSQL private; do not expose port
5432 publicly.

`realtime.c2c.sh` proxies to Convex's core/realtime port `3210`.
`api.c2c.sh` proxies independently to the HTTP-action port `3211`, which owns
all webhook and callback routes. Only Caddy publishes ports 80 and 443.

SSH is open on port 22 only to the operator's address. Connect with:

```bash
bash infra/aws/production/ssh.sh
```

The helper defaults to `~/.ssh/code2create-production-aws`. Set
`C2C_SSH_KEY` to override it.
The security-group SSH rule should remain a `/32`; update it when the operator
address changes instead of opening SSH to the whole internet.

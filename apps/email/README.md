# Code2Create email service

This Worker is the authenticated outbound-email boundary for Code2Create. A published communications policy selects either Amazon SES or Cloudflare Email Sending for each participant message. The Worker also consumes Cloudflare lifecycle events and forwards the approved inbound support alias through Cloudflare Email Routing.

The service never falls back from one provider to the other after a request. A transport failure can be ambiguous, so automatic cross-provider fallback could send a duplicate message.

## Staging setup

1. Create the event queue and its dead-letter queue:

   ```sh
   pnpm --filter @code2create/email queue:create:staging
   ```

2. Set the shared service and routing secrets:

   ```sh
   pnpm --filter @code2create/email exec wrangler secret put CONVEX_EMAIL_EVENT_CALLBACK_URL --env staging --config wrangler.jsonc
   pnpm --filter @code2create/email exec wrangler secret put EMAIL_EVENT_CALLBACK_SECRET --env staging --config wrangler.jsonc
   pnpm --filter @code2create/email exec wrangler secret put EMAIL_SEND_INGRESS_SECRET --env staging --config wrangler.jsonc
   pnpm --filter @code2create/email exec wrangler secret put EMAIL_ROUTING_ADDRESS --env staging --config wrangler.jsonc
   pnpm --filter @code2create/email exec wrangler secret put EMAIL_ROUTING_FORWARD_TO --env staging --config wrangler.jsonc
   pnpm --filter @code2create/email exec wrangler secret put EMAIL_SENDING_DOMAIN --env staging --config wrangler.jsonc
   ```

   `EMAIL_EVENT_CALLBACK_SECRET` and `EMAIL_SEND_INGRESS_SECRET` must equal their backend values. Each must contain at least 32 bytes. `EMAIL_ROUTING_ADDRESS` is the one literal inbound alias accepted by the Worker. `EMAIL_ROUTING_FORWARD_TO` must be a verified Email Routing destination.

3. Configure at least one outbound provider. For Amazon SES:

   ```sh
   pnpm --filter @code2create/email exec wrangler secret put AWS_SES_REGION --env staging --config wrangler.jsonc
   pnpm --filter @code2create/email exec wrangler secret put AWS_SES_ACCESS_KEY_ID --env staging --config wrangler.jsonc
   pnpm --filter @code2create/email exec wrangler secret put AWS_SES_SECRET_ACCESS_KEY --env staging --config wrangler.jsonc
   pnpm --filter @code2create/email exec wrangler secret put AWS_SES_FROM --env staging --config wrangler.jsonc
   ```

   Optional SES values are `AWS_SES_SESSION_TOKEN`, `AWS_SES_REPLY_TO`, and `AWS_SES_CONFIGURATION_SET`. The IAM identity needs only `ses:SendEmail` for the approved SES identity. Verify the sender identity in the selected region and request production access before sending to arbitrary recipients.

   To retain Cloudflare Email Sending as an alternative:

   ```sh
   pnpm --filter @code2create/email exec wrangler secret put CLOUDFLARE_EMAIL_ACCOUNT_ID --env staging --config wrangler.jsonc
   pnpm --filter @code2create/email exec wrangler secret put CLOUDFLARE_EMAIL_API_TOKEN --env staging --config wrangler.jsonc
   pnpm --filter @code2create/email exec wrangler secret put CLOUDFLARE_EMAIL_FROM --env staging --config wrangler.jsonc
   ```

   `CLOUDFLARE_EMAIL_REPLY_TO` is optional. Give the token send-only permission.

4. Set these Convex environment values:

   - `EMAIL_SERVICE_URL=https://<email-worker-host>`
   - the matching `EMAIL_SEND_INGRESS_SECRET`
   - `AUTHENTICATION_EMAIL_PROVIDER=aws_ses` or `cloudflare_email`

   Participant-status messages use the provider stored in the published communications policy. Authentication email uses `AUTHENTICATION_EMAIL_PROVIDER`.

5. Connect `code2create-email-staging` to repository branch `staging` with root directory `apps/email`, build command `pnpm cloudflare:build:staging`, and deploy command `pnpm cloudflare:deploy:staging`. Non-production branch builds stay disabled. For an authorized manual recovery deployment:

   ```sh
   pnpm --filter @code2create/email deploy:staging
   ```

6. Create the Cloudflare Email Sending Event Subscription on `code2create-email-events-staging` if Cloudflare remains enabled:

   ```sh
   pnpm --filter @code2create/email subscription:create:staging
   ```

   - Source: Email Sending.
   - Domain: the exact `EMAIL_SENDING_DOMAIN`.
   - Events: `message.delivered`, `message.deferred`, `message.bounced`, `message.failed`, `message.rejected`, and `message.complained`.

7. Verify the subscription through the CLI:

   ```sh
   pnpm --filter @code2create/email subscription:list:staging
   ```

8. Enable Email Routing for the selected domain. Create and verify the forwarding destination. Then route the approved support alias to `code2create-email-staging`:

   ```sh
   pnpm --filter @code2create/email exec wrangler email routing enable <domain>
   pnpm --filter @code2create/email exec wrangler email routing addresses create <operations-address>
   pnpm --filter @code2create/email exec wrangler email routing rules create <domain> --name code2create-support-staging --match-type literal --match-field to --match-value <support-alias> --action-type worker --action-value code2create-email-staging
   ```

Cloudflare sends a verification message before a new forwarding destination becomes active. Do not enable the route until that verification is complete.

Cloudflare lifecycle events continue to update delivered, delayed, bounced, failed, suppressed, and complaint states for Cloudflare sends. SES acceptance records the SES message ID and a queued state. Configure an SES event destination separately before treating SES provider events as delivery confirmation; this Worker does not ingest SES events yet.

## Production setup

Production uses:

- Worker: `code2create-email` at `https://email.c2c.sh`
- delivery-event queue: `code2create-email-events`
- dead-letter queue: `code2create-email-events-dlq`
- sending domain: `c2c.sh`
- inbound support alias: `support@c2c.sh`

Create the queues before the first deployment, onboard `c2c.sh` in Cloudflare
Email Sending, and then create the delivery-event subscription:

```sh
pnpm --filter @code2create/email queue:create:production
pnpm --filter @code2create/email subscription:create:production
pnpm --filter @code2create/email subscription:list:production
```

Email Routing forwards only the literal `support@c2c.sh` address to the verified
operations mailbox through `code2create-email`. The delivery-event subscription
is separate from Email Routing and cannot be created until Cloudflare reports
`c2c.sh` as an enabled Email Sending domain.

## Release checks

Run these commands before each deployment:

```sh
pnpm --filter @code2create/email lint
pnpm --filter @code2create/email typecheck
pnpm --filter @code2create/email test
pnpm --filter @code2create/email build
```

The build is a Wrangler staging dry-run. It does not send email or change Cloudflare resources.

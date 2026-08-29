# Code2Create email bridge

This Worker consumes Cloudflare Email Sending lifecycle events. It also forwards the approved inbound support alias through Cloudflare Email Routing.

## Staging setup

1. Create the event queue and its dead-letter queue:

   ```sh
   pnpm --filter @code2create/email queue:create:staging
   ```

2. Set the five Worker secrets:

   ```sh
   pnpm --filter @code2create/email exec wrangler secret put CONVEX_EMAIL_EVENT_CALLBACK_URL --env staging --config wrangler.jsonc
   pnpm --filter @code2create/email exec wrangler secret put EMAIL_EVENT_CALLBACK_SECRET --env staging --config wrangler.jsonc
   pnpm --filter @code2create/email exec wrangler secret put EMAIL_ROUTING_ADDRESS --env staging --config wrangler.jsonc
   pnpm --filter @code2create/email exec wrangler secret put EMAIL_ROUTING_FORWARD_TO --env staging --config wrangler.jsonc
   pnpm --filter @code2create/email exec wrangler secret put EMAIL_SENDING_DOMAIN --env staging --config wrangler.jsonc
   ```

   `EMAIL_EVENT_CALLBACK_SECRET` must equal the backend secret. `EMAIL_ROUTING_ADDRESS` is the one literal inbound alias accepted by the Worker. `EMAIL_ROUTING_FORWARD_TO` must be a verified Email Routing destination.

3. Connect `code2create-email-staging` to repository branch `staging` with root directory `apps/email`, build command `pnpm cloudflare:build:staging`, and deploy command `pnpm cloudflare:deploy:staging`. Non-production branch builds stay disabled. For an authorized manual recovery deployment:

   ```sh
   pnpm --filter @code2create/email deploy:staging
   ```

4. Create the Email Sending Event Subscription on `code2create-email-events-staging`:

   ```sh
   pnpm --filter @code2create/email subscription:create:staging
   ```

   - Source: Email Sending.
   - Domain: the exact `EMAIL_SENDING_DOMAIN`.
   - Events: `message.delivered`, `message.deferred`, `message.bounced`, `message.failed`, `message.rejected`, and `message.complained`.

5. Verify the subscription through the CLI:

   ```sh
   pnpm --filter @code2create/email subscription:list:staging
   ```

6. Enable Email Routing for the selected domain. Create and verify the forwarding destination. Then route the approved support alias to `code2create-email-staging`:

   ```sh
   pnpm --filter @code2create/email exec wrangler email routing enable <domain>
   pnpm --filter @code2create/email exec wrangler email routing addresses create <operations-address>
   pnpm --filter @code2create/email exec wrangler email routing rules create <domain> --name code2create-support-staging --match-type literal --match-field to --match-value <support-alias> --action-type worker --action-value code2create-email-staging
   ```

Cloudflare sends a verification message before a new forwarding destination becomes active. Do not enable the route until that verification is complete.

## Production setup

Use the equivalent `production` scripts only after O-034 fixes the production domain, sender, support alias, forwarding destination, reply policy, and retention policy. Production uses `code2create-email-events`, `code2create-email-events-dlq`, and the `code2create-email` Worker.

## Release checks

Run these commands before each deployment:

```sh
pnpm --filter @code2create/email lint
pnpm --filter @code2create/email typecheck
pnpm --filter @code2create/email test
pnpm --filter @code2create/email build
```

The build is a Wrangler staging dry-run. It does not send email or change Cloudflare resources.

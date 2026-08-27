# Outbound voice service

This Cloudflare Worker places one synthesized phone call for one accepted delivery ID. Convex decides whether a call is allowed. The Worker cannot read event data or create a page.

The current reviewer flow is push first. A missing push address can call immediately; otherwise the first unanswered 30-second repage can call. The reviewer must have current phone-call consent. The page chain must still hold its exact call authority. A call asks the reviewer to open the app and never accepts or declines the page.

The Worker uses:

- one Durable Object per delivery ID for idempotency and callback recovery;
- Sarvam `bulbul:v3` for MP3 speech synthesis;
- Twilio Programmable Voice for the call and status callbacks;
- separate HMAC secrets for Convex requests and Worker callbacks.

Copy `.env.example` to `.dev.vars` for local provider testing. Do not commit it. Set the same request and callback secrets on the matching Convex deployment. Configure the remaining provider secrets on each Cloudflare Worker environment before deployment.

Cloudflare Workers Builds deploys staging from repository branch `staging`, root directory `apps/voice`, build command `pnpm cloudflare:build:staging`, and deploy command `pnpm cloudflare:deploy:staging`. Non-production branch builds stay disabled.

```sh
pnpm --filter @code2create/voice dev
pnpm --filter @code2create/voice test
pnpm --filter @code2create/voice build
pnpm --filter @code2create/voice deploy:staging
```

The reusable protocol is in `packages/domain/src/voice.ts`. A participant operational-call release must add its own consent copy, source validation, permission rule, and bounded script policy before it can create deliveries.

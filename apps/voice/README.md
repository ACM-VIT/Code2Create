# Outbound voice service

This Cloudflare Worker places one synthesized phone call for one accepted delivery ID. Convex decides whether a call is allowed. The Worker cannot read event data or create a page.

The current reviewer flow is push first. A missing push address can call immediately; otherwise the first unanswered 30-second repage can call. The reviewer must have current phone-call consent. The page chain must still hold its exact call authority. A call asks the reviewer to open the app and never accepts or declines the page.

The Worker uses:

- one Durable Object per delivery ID for idempotency and callback recovery;
- Twilio Programmable Voice as the primary carrier;
- Sarvam Voice Agents Instant Outbound as the backup path, using the Vobiz
  connection already managed in Sarvam;
- separate HMAC secrets for Convex requests and Worker callbacks.

The Worker tries Sarvam when Twilio is not configured or explicitly rejects the
create request. It does not double-dial after a timeout, connection reset, HTTP
5xx, or malformed success response because the first provider may already have
accepted the call. Sarvam's completion webhook is idempotent and bound to the
same per-delivery Durable Object with an unguessable callback URL token. A valid
late provider callback can resolve a previously ambiguous dispatch without
placing another call.

Copy `.env.example` to `.dev.vars` for local provider testing. Do not commit it. Set the same request and callback secrets on the matching Convex deployment. Configure the remaining provider secrets on each Cloudflare Worker environment before deployment. `SARVAM_VOICE_AGENTS_API_KEY` must be a non-empty key created under Voice Agents Settings, and `SARVAM_APP_VERSION` must be the committed version used by the active inbound/outbound deployment.

The Sarvam app version is a separate deployment prerequisite. The Worker controls the exact initial message—starting with `hi, i'm calling on behalf of the code2create team`—but Sarvam controls the speaker, base instructions, and hang-up behavior. Configure the selected version with the approved English voice, no provider-branded greeting, and instructions to deliver the alert and end the call. Instant Outbound supports an initial-message override but not a per-call forced-hangup instruction, so staging release validation must include a real call that verifies both the spoken introduction and termination behavior.

Cloudflare Workers Builds deploys staging from repository branch `staging`, root directory `apps/voice`, build command `pnpm cloudflare:build:staging`, and deploy command `pnpm cloudflare:deploy:staging`. Production uses branch `main`, the corresponding `production` commands, and `https://voice.c2c.sh`. Non-production branch builds stay disabled.

```sh
pnpm --filter @code2create/voice dev
pnpm --filter @code2create/voice test
pnpm --filter @code2create/voice build
pnpm --filter @code2create/voice deploy:staging
pnpm --filter @code2create/voice deploy:production
```

The reusable protocol is in `packages/domain/src/voice.ts`. A participant operational-call release must add its own consent copy, source validation, permission rule, and bounded script policy before it can create deliveries.

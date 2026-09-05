# Outbound voice service

This Cloudflare Worker places one phone call for one accepted delivery ID. Convex decides whether a call is allowed. The Worker cannot read event data or create a page.

The current reviewer flow is push first. A missing push address can call immediately; otherwise the first unanswered 30-second repage can call. The reviewer must have current phone-call consent. The page chain must still hold its exact call authority. A call asks the reviewer to open the app and never accepts or declines the page.

The Worker uses:

- one Durable Object per delivery ID for idempotency and callback recovery;
- Twilio Programmable Voice and Sarvam Voice Agents Instant Outbound over the
  Vobiz connection already managed in Sarvam;
- separate HMAC secrets for Convex requests and Worker callbacks.

`OUTBOUND_CALL_PRIMARY_PROVIDER` selects `twilio` or `sarvam` as the first
provider for each environment; it defaults to `twilio`. The
other fully configured provider remains the fallback when the selected provider
is unavailable or explicitly rejects the create request. The Worker does not
fail over after a timeout, connection reset, HTTP 5xx, or malformed success
response because the first provider may already have accepted the call. Sarvam's
completion webhook is idempotent and bound to the same per-delivery Durable
Object with an unguessable callback URL token. A valid late provider callback
can resolve a previously ambiguous dispatch without placing another call.

Copy `.env.example` to `.dev.vars` for local provider testing. Do not commit it. Set the same request and callback secrets on the matching Convex deployment. Configure `OUTBOUND_CALL_PRIMARY_PROVIDER` and the remaining provider secrets on each Cloudflare Worker environment before deployment. `SARVAM_VOICE_AGENTS_API_KEY` must be a non-empty key created under Voice Agents Settings, and `SARVAM_APP_VERSION` must identify the committed agent version. Instant Outbound does not require an inbound deployment.

The Sarvam app version is a separate deployment prerequisite. The Worker supplies `agent_variables.call_message`, starting with `hi, i'm calling on behalf of the code2create team`. Declare that input on every selected agent, include it in context, and set the greeting and every greeting translation to `{{call_message}}`. Regenerate and save translations before committing a version. A live rehearsal found that the initial-message override still played a stale provider-branded English translation; the service now uses the explicit input variable. Sarvam controls the speaker, instructions and end-call behavior. Release validation must include a real call that checks the actual greeting, conversation and termination. See [review call agent setup](agents/review-calls.md).

Cloudflare Workers Builds deploys staging from repository branch `staging`, root directory `apps/voice`, build command `pnpm cloudflare:build:staging`, and deploy command `pnpm cloudflare:deploy:staging`. Production uses branch `main`, the corresponding `production` commands, and `https://voice.c2c.sh`. Non-production branch builds stay disabled.

```sh
pnpm --filter @code2create/voice dev
pnpm --filter @code2create/voice test
pnpm --filter @code2create/voice build
pnpm --filter @code2create/voice deploy:staging
pnpm --filter @code2create/voice deploy:production
```

The reusable protocol is in `packages/domain/src/voice.ts`. Participant review calls use their saved profile phone, explicit consent and current review-queue authority. Spoken acknowledgement does not change a review assignment or attendance.

## Conversational venue checks

Venue checks use a dedicated published Sarvam agent selected in ops. They pass its ID/version in the signed request and do not fall back to an announcement provider. The existing short announcement calls keep their provider order.

The completion webhook carries a structured response and transcript. The Worker validates them and relays them through the existing signed callback. Convex records the response separately from delivery status, validates the still-current source/consent/policy/expiry, and requests staffing replacement for a confirmed absence only between reviews. An unclear response, help request or absence during active/scoring review needs ops follow-up. An answered or completed call alone never confirms availability. No answer remains a distinct delivery outcome. An available response does not invent an inside-GPS reading or replace pre-round confirmation.

The app's call consent now explains conversation and transcript storage. Old announcement-only venue consent requires confirmation again. Audio recording is not enabled or downloaded by this integration. See [agent instructions, variables and rehearsal](agents/venue-confirmation.md) for the concrete provider configuration. No provider agent was published or live call placed during local implementation.

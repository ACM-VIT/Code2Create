# Outbound voice service

This Cloudflare Worker places one phone call for one accepted delivery ID. Convex decides whether a call is allowed. The Worker cannot read event data or create a page.

Participant outings automatically call once when the exit scan's 15-minute return deadline passes. Convex owns the deadline, source deduplication, eligibility and return checks; its recovery sweep covers existing overdue outings. The request carries `requiredProvider: "sarvam"`, so it uses the pinned event reminder agent even when Twilio is the environment's primary provider, and never falls back to Twilio. Through `call_message`, the existing agent explains that the participant has exceeded their 15-minute break and other people are waiting, then asks them to come back now. The spoken reminder does not ask for an ID scan. No new agent version or agent credentials are needed. Call outcomes appear beside overdue participants in ops. Phone answers and provider completion do not change attendance or release capacity.

Release the voice Worker before the backend that emits this request field, then release the ops and participant web clients. Local verification uses mocked provider requests and callbacks; it does not place participant calls.

The current reviewer flow is push first. A missing push address can call immediately; otherwise the first unanswered reminder can call. Its delay is half the page response window, capped at 30 seconds: a default 30-second page can escalate after 15 seconds. The reviewer must have current phone-call consent. The page chain must still hold its exact call authority. A call asks the reviewer to open the app and never accepts or declines the page. Scheduled shift reminders currently use push; adding voice for that purpose is tracked in the [event follow-up plan](../../specs/16-event-follow-up-plan.md).

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

The Sarvam app version is a separate deployment prerequisite. The Worker supplies the call context in `agent_variables.call_message`. Declare that input on every selected agent and include it in context. The published greeting first asks whether the caller can hear the agent; after their reply, the agent delivers the supplied message. Keep every greeting translation aligned with that opening. Sarvam controls the speaker, instructions and end-call behavior. Release validation must include a real call that checks the greeting, caller replies and audible closing message. See the [event reminder agent setup](agent/reminder.md).

Cloudflare Workers Builds deploys staging from repository branch `staging`, root directory `apps/voice`, build command `pnpm cloudflare:build:staging`, and deploy command `pnpm cloudflare:deploy:staging`. Production uses branch `main`, the corresponding `production` commands, and `https://voice.c2c.sh`. Non-production branch builds stay disabled.

```sh
pnpm --filter @code2create/voice dev
pnpm --filter @code2create/voice test
pnpm --filter @code2create/voice build
pnpm --filter @code2create/voice deploy:staging
pnpm --filter @code2create/voice deploy:production
```

The reusable protocol is in `packages/domain/src/voice.ts`. Participant RSVP reminders and review call-ups are automatic event updates to the team lead's saved profile phone, without participant opt-in controls. Ops configures the RSVP reminder time and response deadline. The backend rechecks the unanswered offer or review queue, current lead and phone, and exact authority before dispatch. Spoken acknowledgement does not confirm an RSVP, change a review assignment, or record attendance.

## Conversational venue checks

Venue checks use a dedicated published Sarvam agent selected in ops. They pass its ID/version in the signed request and do not fall back to an announcement provider. The existing short announcement calls keep their provider order.

The completion webhook carries a structured response and transcript. The Worker validates them and relays them through the existing signed callback. Convex records the response separately from delivery status, validates the still-current source/consent/policy/expiry, and requests staffing replacement for a confirmed absence only between reviews. An unclear response, help request or absence during active/scoring review needs ops follow-up. An answered or completed call alone never confirms availability. No answer remains a distinct delivery outcome. An available response does not invent an inside-GPS reading or replace pre-round confirmation.

The app's call consent now explains conversation and transcript storage. Old announcement-only venue consent requires confirmation again. Audio recording is not enabled or downloaded by this integration. See [agent instructions, variables and rehearsal](agents/venue-confirmation.md) for the concrete provider configuration. No provider agent was published or live call placed during local implementation.

Reviewer shift calls use the same outbound delivery service. Ops chooses the lead time and enables calling in staffing settings. The backend rechecks confirmed hours, clock-in, round state, reminder timing, consent and reviewer access at dispatch, and deduplicates calls by the shift notice. The call gives the actual shift start time and directs the reviewer to the app. The updated reviewer call notice covers both shift reminders and substitute calls; GPS conversation consent remains separate.

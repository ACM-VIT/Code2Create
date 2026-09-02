# Idea-round realtime load check

This driver opens real Convex WebSocket subscriptions against an explicitly approved Code2Create target. Its default profile does not create or edit product data.

Run a public transport and shared-query check:

```sh
C2C_LOAD_CONVEX_URL=https://realtime-staging.c2c.sh \
C2C_LOAD_ACKNOWLEDGE=code2create-staging \
pnpm --filter @code2create/backend load:idea-round
```

Set `C2C_LOAD_MODE=participant` and `C2C_LOAD_TOKEN_FILE=/absolute/path/tokens.json` to add authenticated `participants.me` and `intake.current` subscriptions for each client. The file must be a JSON array with one distinct short-lived staging JWT per client. Every token must resolve to a different fully onboarded participant in a valid intake team. The driver verifies those identities and team sizes from live query results; null or duplicate fixtures cannot pass. The command never prints tokens.

To exercise the actual idea-round write path, use a disposable event whose slug starts with `load-`. Prepare its participants in ordinary unsubmitted teams, publish a staging novelty corpus, and run:

```sh
C2C_LOAD_CONVEX_URL=https://realtime-staging.c2c.sh \
C2C_LOAD_EVENT_SLUG=load-idea-round \
C2C_LOAD_MODE=participant \
C2C_LOAD_WORKLOAD=idea-editing \
C2C_LOAD_TOKEN_FILE=/absolute/path/load-tokens.json \
C2C_LOAD_ACKNOWLEDGE=code2create-staging-writes \
pnpm --filter @code2create/backend load:idea-round
```

The mutating profile spreads 25% of eligible participant clients across the real ten-second presence heartbeat. It chooses one committing writer per active team, autosaves changed working text every five seconds, and requests novelty every fifteen seconds. Other active teammates remain subscribed and present without manufacturing expected autosave conflicts. Override the percentage and intervals only to model a measured workload. The driver refuses this profile for the real event slug and leaves the disposable teams' working text changed, so delete the load event after the run.

Use a second fresh disposable event to rehearse the participant-facing intake and AI queue. Include every member token so all clients remain subscribed, but leave every team without a draft or application. The driver finds the single lead for each team, saves an idea, answers the two published fixed questions, then answers both generated-or-fallback questions and verifies that the team reaches review:

```sh
C2C_LOAD_CONVEX_URL=https://realtime-staging.c2c.sh \
C2C_LOAD_EVENT_SLUG=load-intake-burst \
C2C_LOAD_MODE=participant \
C2C_LOAD_WORKLOAD=intake-burst \
C2C_LOAD_CONNECTION_RAMP_MS=60000 \
C2C_LOAD_WORKLOAD_RAMP_MS=1000 \
C2C_LOAD_TOKEN_FILE=/absolute/path/load-tokens.json \
C2C_LOAD_ACKNOWLEDGE=code2create-staging-writes \
pnpm --filter @code2create/backend load:idea-round
```

This gate requires exactly four questions per team: two fixed questions and two model-or-fallback questions. It requires at least one validated model question across the run, 99% of teams at review, both adaptive slots to resolve inside the 20-second boundary plus propagation allowance, and no team to receive more than two model questions. The driver invokes the same idempotent deadline-settlement mutation as the participant browser, checks mutation latency, and rejects fixtures with a missing or duplicate team lead.

Use `submission-burst` with review-ready teams to exercise freshness attestation, the exact confirmation preview, lead-only submission, and asynchronous application materialization. Use `full-flow` with fresh teams to run `intake-burst` and then `submission-burst` over the same subscribed clients.

Live production is deliberately read-only. It accepts only the unpublished `code2create-7` public shell query:

```sh
C2C_LOAD_CONVEX_URL=https://realtime.c2c.sh \
C2C_LOAD_EVENT_SLUG=code2create-7 \
C2C_LOAD_MODE=public \
C2C_LOAD_WORKLOAD=subscriptions \
C2C_LOAD_ACKNOWLEDGE=code2create-production-readonly \
pnpm --filter @code2create/backend load:idea-round
```

Production write and AI capacity proof runs only against the disposable production-shaped backend at `https://realtime-load.c2c.sh`, with an event slug beginning with `load-` and `C2C_LOAD_ACKNOWLEDGE=code2create-production-rehearsal`. `load:prepare-rehearsal` creates synthetic Google claims, profiles, GitHub-star completions, and teams through the real product mutations, then writes one owner-only identity per participant to `C2C_LOAD_IDENTITY_FILE`. Run the driver with that file and the isolated backend's `C2C_LOAD_ADMIN_KEY`; synthetic admin identities are rejected on staging and live production. The driver rejects a mutating workload pointed at `realtime.c2c.sh` even if another acknowledgement is supplied.

Fixture preparation uses `C2C_LOAD_PREP_CONCURRENCY` and defaults to eight workers. Keep preparation paced: it establishes test state and is not the measured participant burst. `C2C_LOAD_CONCURRENCY` controls the measured workload separately.

The default profile ramps 3,000 clients over 60 seconds and holds them for two minutes. `C2C_LOAD_CONNECTION_RAMP_MS` controls only browser connection establishment. `C2C_LOAD_WORKLOAD_RAMP_MS` controls the measured write burst independently, so a rehearsal can establish all 3,000 subscriptions before releasing every team-lead intake write over one second. A mutating profile will not start unless every authenticated fixture client is ready. The gate fails unless at least 99.5% become ready, subscription errors stay at or below 0.5%, initial result p95 is at most five seconds, p99 is at most ten seconds, and the load-driver event loop remains healthy. Run it from a separate machine so a saturated laptop is not mistaken for a backend failure.

The idea-editing profile also requires autosave and presence p95 at or below two seconds, novelty p99 at or below ten seconds, and at most one percent failed workload operations. A novelty result may be **Unavailable** because shedding optional provider traffic is expected; an action error, timeout, stuck request, or blocked proposal write is not.

The approved origins are exact. A hostname that merely contains `staging` or resembles a Code2Create domain is rejected.

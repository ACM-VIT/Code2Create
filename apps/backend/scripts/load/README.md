# Idea-round realtime load check

This driver opens real Convex WebSocket subscriptions against staging. Its default profile does not create or edit product data.

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

Use a second fresh disposable event to rehearse the participant-facing intake and AI queue. Include every member token so all clients remain subscribed, but leave every team without a draft or application. The driver finds the single lead for each team, saves an idea, answers the two published fixed questions, waits for up to two adaptive questions, and verifies that the team reaches review:

```sh
C2C_LOAD_CONVEX_URL=https://realtime-staging.c2c.sh \
C2C_LOAD_EVENT_SLUG=load-intake-burst \
C2C_LOAD_MODE=participant \
C2C_LOAD_WORKLOAD=intake-burst \
C2C_LOAD_TOKEN_FILE=/absolute/path/load-tokens.json \
C2C_LOAD_ACKNOWLEDGE=code2create-staging-writes \
pnpm --filter @code2create/backend load:idea-round
```

This gate requires exactly two fixed questions per team, no more than two model questions per team, at least one validated model question across the run, 99% of teams at review, and the backend's 20-second adaptive-question deadline to hold. It also checks mutation latency and rejects fixtures with a missing or duplicate team lead. A model may correctly decide that a specific proposal needs no adaptive question, so the gate does not require one for every team.

The default profile ramps 3,000 clients over 60 seconds and holds them for two minutes. It fails unless at least 99.5% become ready, subscription errors stay at or below 0.5%, initial result p95 is at most five seconds, p99 is at most ten seconds, and the load-driver event loop remains healthy. Run it from a separate machine so a saturated laptop is not mistaken for a backend failure.

The idea-editing profile also requires autosave and presence p95 at or below two seconds, novelty p99 at or below ten seconds, and at most one percent failed workload operations. A novelty result may be **Unavailable** because shedding optional provider traffic is expected; an action error, timeout, stuck request, or blocked proposal write is not.

The driver refuses non-staging hosts. Use a dedicated production-shaped environment for final capacity proof; do not point it at the live event.

# Discord support bridge

This service mirrors Convex support cases into the Code2Create Discord server. The operations
dashboard remains the source of truth and keeps its existing workflows. Each case receives one
private text channel in an open support category. Resolving or closing a case moves that channel
to a closed support category; reopening it moves the channel back. The configured categories are
the first category and permission template for each state. When one reaches Discord's 50-channel
limit, the bot creates and reuses numbered categories such as `c2c-support-open-02` and
`c2c-support-closed-02`.

Messages written in a ticket channel by a Discord administrator or a member with an allowed role become public support notes
on the website. Roles are fetched for each reply so access changes take effect immediately. Bot and webhook messages are ignored. Discord message IDs and backend delivery
claims make both directions idempotent.

## Configured from the dashboard

Two settings live in operations under **Event setup → Operations → Discord support**
(`/configuration/discord`), not in this service's environment. They ride along with the poll the
bot already makes, so a change takes effect within one sync interval and needs no redeploy.

- **Reply receipts.** Whether the bot marks a staff reply with its outcome: ✅ recorded, ⛔ not
  allowed, 🔒 case closed, ⚠️ too short, ❓ unexpected. Switching them off silences all of them,
  including the ones reporting a reply was *not* recorded.
- **Who may reply.** Discord role IDs allowed to answer a ticket, alongside guild administrators.
  Empty means the `DISCORD_ALLOWED_ROLE_IDS` below still stand, so an unconfigured event behaves
  exactly as it always has.

Reading them needs `support.case.read`; changing them needs `support.case.manage`, and each save is
audited with a reason.

`DISCORD_ALLOWED_ROLE_IDS` remains the deployment's own list. It is still what the startup contract
checks the category permission overwrites against — which roles can *see* a ticket channel is a
deployment concern, so a dashboard edit can never widen who reads support traffic. A bot that has
not yet reached the backend uses it for replies too.

## Discord application

- Application ID: `1336816810699264091`
- Guild: `1411784063571988722`
- Open category: `1412182400401936394`
- Closed category: `1544633324776067212`
- Allowed roles: `1411787267244032010`, `1412173230717800538`

Enable the bot's **Message Content Intent** in the Discord developer portal. The bot needs View
Channels, Manage Channels, Send Messages, Read Message History, and Add Reactions in both base
categories, plus guild-level Manage Channels so it can create rollover categories. Neither base or
rollover category may be visible to `@everyone`; startup fails closed if the category, role, or
permission contract is invalid. Rollover categories copy the base category's permission
overwrites and are rediscovered after restarts.

## Production operation

The production VM reads `discord-bot-token` and `discord-support-bridge-secret` from
`kv-c2c-prod-b88416`. Convex uses the same bridge secret and
`DISCORD_SUPPORT_ACTOR_EMAIL=technicaldirector.acmvit@gmail.com`. The actor must remain active and
hold `support.case.manage`; individual Discord authors are retained on support actions for audit.

Build and test locally with:

```sh
pnpm --filter @code2create/discord typecheck
pnpm --filter @code2create/discord test
docker build --file apps/discord/Dockerfile --tag code2create-discord:test .
```

After the matching backend revision is live, deploy the bot revision with:

```sh
infra/azure/production/deploy-discord.sh "$(git rev-parse HEAD)"
```

The deployment builds on the production VM, starts a separate systemd unit, waits for the bridge
health check, and restores the previous image if startup fails. It does not restart the Convex
backend.

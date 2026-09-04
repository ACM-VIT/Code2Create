# Discord support bridge

This service mirrors Convex support cases into the Code2Create Discord server. The operations
dashboard remains the source of truth and keeps its existing workflows. Each case receives one
private text channel in the configured open category. Resolving or closing a case moves that
channel to the configured closed category; reopening it moves the channel back.

Messages written in a ticket channel by a member with an allowed role become public support notes
on the website. Bot and webhook messages are ignored. Discord message IDs and backend delivery
claims make both directions idempotent.

## Discord application

- Application ID: `1336816810699264091`
- Guild: `1411784063571988722`
- Open category: `1412182400401936394`
- Closed category: `1544633324776067212`
- Allowed roles: `1411787267244032010`, `1412173230717800538`

Enable the bot's **Message Content Intent** in the Discord developer portal. The bot needs View
Channels, Manage Channels, Send Messages, Read Message History, and Add Reactions in both
categories. Neither category may be visible to `@everyone`; startup fails closed if the category,
role, or permission contract is invalid.

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

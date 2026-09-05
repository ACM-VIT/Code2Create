export const discordSupportPullSignatureContext =
  "code2create.discord-support.pull.v1";
export const discordSupportAcknowledgeSignatureContext =
  "code2create.discord-support.acknowledge.v1";
export const discordSupportRejectSignatureContext =
  "code2create.discord-support.reject.v1";
export const discordSupportReplySignatureContext =
  "code2create.discord-support.reply.v1";

/**
 * The version a current bot speaks. 2 added the bridge settings the dashboard
 * owns to every poll answer.
 */
export const discordSupportBridgeProtocolVersion = 2 as const;

/**
 * Every version the backend still answers.
 *
 * The bot runs on a VM and the backend deploys on its own, so the two are never
 * updated in the same instant. The backend keeps serving the older version and
 * answers each caller in the shape that caller asked for, which lets a bot that
 * has not been restarted yet carry on delivering tickets through the window.
 */
export const supportedDiscordSupportBridgeProtocolVersions = [1, 2] as const;

export type DiscordSupportBridgeProtocolVersion =
  (typeof supportedDiscordSupportBridgeProtocolVersions)[number];

/**
 * The bridge settings the operations dashboard owns and the bot reads.
 *
 * Both were deployment configuration the bot parsed once at startup, so
 * changing either meant editing the environment and restarting. They belong to
 * the people running the event rather than to a deploy, so the dashboard holds
 * them and the bot picks them up on its next poll.
 */
export interface DiscordSupportBridgeSettings {
  /**
   * Whether the bot marks a reply with a receipt. Off silences every reaction,
   * including the ones that report a reply was refused.
   */
  readonly reactionsEnabled: boolean;
  /**
   * Discord role IDs allowed to answer a ticket, alongside guild
   * administrators.
   *
   * Empty is not "no roles": it means nobody has chosen here, so the bot's
   * deployed `DISCORD_ALLOWED_ROLE_IDS` remain in effect. That keeps an
   * unconfigured event working rather than locking every non-administrator out
   * of support the moment this setting exists.
   */
  readonly allowedRoleIds: readonly string[];
}

/**
 * What the bridge falls back to before anyone has configured it: receipts on,
 * and the bot's deployed roles still in effect.
 */
export const defaultDiscordSupportBridgeSettings: DiscordSupportBridgeSettings = {
  reactionsEnabled: true,
  allowedRoleIds: [],
};

/** A Discord snowflake: the id form used for guilds, roles and channels. */
export const discordSnowflakePattern = /^\d{6,32}$/u;

/** How many roles one event may allow. A guard on the stored list, not a policy. */
export const maximumDiscordAllowedRoles = 25;

/**
 * The allowed roles, cleaned for storage: trimmed, de-duplicated, snowflakes
 * only, in the order given. Throws nothing — the caller decides what an empty
 * result means.
 */
export function normalizeDiscordAllowedRoleIds(
  roleIds: readonly string[],
): string[] {
  const seen = new Set<string>();
  for (const roleId of roleIds) {
    const trimmed = roleId.trim();
    if (discordSnowflakePattern.test(trimmed)) seen.add(trimmed);
  }
  return [...seen].slice(0, maximumDiscordAllowedRoles);
}

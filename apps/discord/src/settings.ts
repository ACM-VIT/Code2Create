import type { BridgeSettings } from "./contracts.ts";

/**
 * Reading the dashboard's bridge settings against what the bot was deployed
 * with.
 *
 * The settings arrive on the poll, so there is always a window — a fresh bot,
 * or a backend it cannot reach — where none have been seen. Every rule here
 * answers the same way in that window as the bot did before the dashboard
 * owned any of this, so losing contact with the backend never changes how the
 * bridge treats a reply.
 */

/**
 * The roles allowed to answer a ticket.
 *
 * The dashboard's list wins when it has one. Empty means nobody has chosen, so
 * the deployment's roles stand — which keeps an unconfigured event working
 * rather than silently locking every replier out of support.
 *
 * Replies only. Which roles can *see* a ticket channel is checked at startup
 * against the category overwrites and stays a deployment concern, so a
 * dashboard edit can never widen who reads support traffic.
 */
export function replyRoleIds(
  settings: BridgeSettings | null,
  deployedRoleIds: readonly string[],
): readonly string[] {
  const configured = settings?.allowedRoleIds ?? [];
  return configured.length > 0 ? configured : deployedRoleIds;
}

/**
 * Whether the bot marks a reply with a receipt.
 *
 * On until the dashboard says otherwise, including before the first poll
 * answers.
 */
export function reactionsAllowed(settings: BridgeSettings | null): boolean {
  return settings?.reactionsEnabled ?? true;
}

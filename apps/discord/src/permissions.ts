import { PermissionFlagsBits, type PermissionsBitField } from "discord.js";

export function canReplyToSupport(
  permissions: Readonly<PermissionsBitField>,
  roleIds: Iterable<string>,
  allowedRoleIds: readonly string[],
) {
  if (permissions.has(PermissionFlagsBits.Administrator)) return true;
  return Array.from(roleIds).some((roleId) => allowedRoleIds.includes(roleId));
}

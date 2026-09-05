import { z } from "zod";

const snowflake = z.string().regex(/^\d{6,32}$/u);

const configSchema = z
  .object({
    DISCORD_BOT_TOKEN: z.string().min(20),
    DISCORD_GUILD_ID: snowflake,
    DISCORD_OPEN_CATEGORY_ID: snowflake,
    DISCORD_CLOSED_CATEGORY_ID: snowflake,
    DISCORD_ALLOWED_ROLE_IDS: z.array(snowflake).min(1),
    DISCORD_SUPPORT_BRIDGE_SECRET: z.string().min(32),
    CONVEX_SITE_URL: z.url(),
    OPERATIONS_SITE_URL: z.url(),
    C2C_EVENT_SLUG: z.string().min(2).max(80),
    PORT: z.coerce.number().int().min(1).max(65_535).default(8080),
  })
  .strict();

export function loadConfig(environment: NodeJS.ProcessEnv) {
  return configSchema.parse({
    DISCORD_BOT_TOKEN: environment.DISCORD_BOT_TOKEN,
    DISCORD_GUILD_ID: environment.DISCORD_GUILD_ID,
    DISCORD_OPEN_CATEGORY_ID: environment.DISCORD_OPEN_CATEGORY_ID,
    DISCORD_CLOSED_CATEGORY_ID: environment.DISCORD_CLOSED_CATEGORY_ID,
    DISCORD_ALLOWED_ROLE_IDS: environment.DISCORD_ALLOWED_ROLE_IDS?.split(",")
      .map((roleId) => roleId.trim())
      .filter((roleId) => roleId.length > 0),
    DISCORD_SUPPORT_BRIDGE_SECRET: environment.DISCORD_SUPPORT_BRIDGE_SECRET,
    CONVEX_SITE_URL: environment.CONVEX_SITE_URL,
    OPERATIONS_SITE_URL: environment.OPERATIONS_SITE_URL,
    C2C_EVENT_SLUG: environment.C2C_EVENT_SLUG,
    PORT: environment.PORT,
  });
}

export type DiscordSupportConfig = ReturnType<typeof loadConfig>;

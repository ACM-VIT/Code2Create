import {
  discordSupportAcknowledgeSignatureContext,
  discordSupportPullSignatureContext,
  discordSupportRejectSignatureContext,
  discordSupportReplySignatureContext,
  signServiceBody,
} from "@code2create/domain";
import type { ZodType } from "zod";

import type { DiscordSupportConfig } from "./config.ts";
import {
  acknowledgementResponseSchema,
  protocolVersion,
  pullResponseSchema,
  rejectResponseSchema,
  replyResponseSchema,
} from "./contracts.ts";

type BridgeRequestPayload = Readonly<Record<string, string | number>>;

export class BridgeRequestError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number) {
    super(`Discord support bridge request failed with ${code}.`);
    this.name = "BridgeRequestError";
    this.code = code;
    this.status = status;
  }
}

export class SupportBackend {
  private readonly config: DiscordSupportConfig;

  constructor(config: DiscordSupportConfig) {
    this.config = config;
  }

  async pull() {
    return await this.post(
      "/integrations/discord/support/pull",
      discordSupportPullSignatureContext,
      { protocolVersion, eventSlug: this.config.C2C_EVENT_SLUG },
      pullResponseSchema,
    );
  }

  async acknowledge(args: {
    deliveryId: string;
    claimId: string;
    discordChannelId: string;
    discordMessageId: string;
  }) {
    return await this.post(
      "/integrations/discord/support/acknowledge",
      discordSupportAcknowledgeSignatureContext,
      {
        protocolVersion,
        ...args,
        discordGuildId: this.config.DISCORD_GUILD_ID,
      },
      acknowledgementResponseSchema,
    );
  }

  async reject(args: { deliveryId: string; claimId: string; errorCode: string }) {
    return await this.post(
      "/integrations/discord/support/reject",
      discordSupportRejectSignatureContext,
      { protocolVersion, ...args },
      rejectResponseSchema,
    );
  }

  async reply(args: {
    discordChannelId: string;
    discordMessageId: string;
    discordUserId: string;
    discordDisplayName: string;
    message: string;
  }) {
    return await this.post(
      "/integrations/discord/support/reply",
      discordSupportReplySignatureContext,
      {
        protocolVersion,
        eventSlug: this.config.C2C_EVENT_SLUG,
        discordGuildId: this.config.DISCORD_GUILD_ID,
        ...args,
      },
      replyResponseSchema,
      [202, 404, 409],
    );
  }

  private async post<T>(
    path: string,
    context: string,
    payload: BridgeRequestPayload,
    schema: ZodType<T>,
    acceptedStatuses: readonly number[] = [200, 202],
  ): Promise<T> {
    const body = JSON.stringify(payload);
    const timestamp = String(Date.now());
    const signature = await signServiceBody({
      context,
      secret: this.config.DISCORD_SUPPORT_BRIDGE_SECRET,
      timestamp,
      body,
    });
    const response = await fetch(new URL(path, this.config.CONVEX_SITE_URL), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-c2c-signature": signature,
        "x-c2c-timestamp": timestamp,
      },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    const responseBody = await response.text();
    let json: unknown;
    try {
      json = JSON.parse(responseBody);
    } catch {
      throw new BridgeRequestError(`http_${response.status}`, response.status);
    }
    if (!acceptedStatuses.includes(response.status)) {
      const errorCode =
        typeof json === "object" && json !== null && "error" in json && typeof json.error === "string"
          ? json.error
          : `http_${response.status}`;
      throw new BridgeRequestError(errorCode, response.status);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new BridgeRequestError("invalid_response", response.status);
    return parsed.data;
  }
}

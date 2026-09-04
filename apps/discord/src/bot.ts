import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  PermissionFlagsBits,
  type CategoryChannel,
  type Guild,
  type Message,
  type TextChannel,
} from "discord.js";

import { BridgeRequestError, SupportBackend } from "./backend.ts";
import type { DiscordSupportConfig } from "./config.ts";
import type { DiscordSupportDelivery, DiscordSupportState } from "./contracts.ts";
import {
  deliveryNonce,
  inboundMessageText,
  renderDelivery,
  splitDiscordMessage,
  supportChannelName,
} from "./messages.ts";

const deliveriesPerDrain = 20;
const syncIntervalMs = 1_500;

function errorCode(error: unknown) {
  if (error instanceof BridgeRequestError) return `backend_${error.code}`.slice(0, 80);
  if (error instanceof Error && /^[A-Za-z0-9_]{2,60}$/u.test(error.name)) {
    return `discord_${error.name.toLowerCase()}`.slice(0, 80);
  }
  return "discord_delivery_failed";
}

async function safeReact(message: Message, emoji: string) {
  try {
    await message.react(emoji);
  } catch {
    // Reactions are delivery receipts only; a missing reaction permission is harmless.
  }
}

function isClosedState(state: DiscordSupportState) {
  return state === "resolved" || state === "closed";
}

function channelTopic(supportCaseId: string) {
  return `Code2Create support case:${supportCaseId}`;
}

export class DiscordSupportBot {
  readonly client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  private readonly backend: SupportBackend;
  private readonly config: DiscordSupportConfig;
  private guild: Guild | null = null;
  private openCategory: CategoryChannel | null = null;
  private closedCategory: CategoryChannel | null = null;
  private syncTimer: NodeJS.Timeout | null = null;
  private draining = false;
  private lastBackendSuccessAt = 0;

  constructor(config: DiscordSupportConfig) {
    this.config = config;
    this.backend = new SupportBackend(config);
    this.client.once(Events.ClientReady, () => {
      void this.onReady().catch((error: unknown) => {
        console.error("discord_support_startup_failed", { code: errorCode(error) });
        process.exit(1);
      });
    });
    this.client.on(Events.MessageCreate, (message) => void this.onMessage(message));
    this.client.on(Events.Error, (error) => {
      console.error("discord_client_error", { code: errorCode(error) });
    });
  }

  async start() {
    await this.client.login(this.config.DISCORD_BOT_TOKEN);
  }

  async stop() {
    if (this.syncTimer !== null) clearInterval(this.syncTimer);
    this.syncTimer = null;
    await this.client.destroy();
  }

  healthy(now = Date.now()) {
    return (
      this.client.isReady() &&
      this.openCategory !== null &&
      this.closedCategory !== null &&
      now - this.lastBackendSuccessAt < 30_000
    );
  }

  private async onReady() {
    const guild = await this.client.guilds.fetch(this.config.DISCORD_GUILD_ID);
    const [openCategory, closedCategory] = await Promise.all([
      guild.channels.fetch(this.config.DISCORD_OPEN_CATEGORY_ID),
      guild.channels.fetch(this.config.DISCORD_CLOSED_CATEGORY_ID),
    ]);
    if (openCategory?.type !== ChannelType.GuildCategory) {
      throw new Error("DISCORD_OPEN_CATEGORY_ID must identify a category.");
    }
    if (closedCategory?.type !== ChannelType.GuildCategory) {
      throw new Error("DISCORD_CLOSED_CATEGORY_ID must identify a category.");
    }
    const botMember = guild.members.me;
    if (botMember === null) throw new Error("The Discord bot guild member is unavailable.");
    const allowedRoles = await Promise.all(
      this.config.DISCORD_ALLOWED_ROLE_IDS.map((roleId) => guild.roles.fetch(roleId)),
    );
    if (allowedRoles.some((role) => role === null)) {
      throw new Error("A configured Discord support role is unavailable.");
    }
    for (const category of [openCategory, closedCategory]) {
      if (category.permissionsFor(guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel)) {
        throw new Error("Discord support categories must not be visible to @everyone.");
      }
      const permissions = category.permissionsFor(botMember);
      for (const permission of [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.AddReactions,
      ]) {
        if (!permissions?.has(permission)) {
          throw new Error("The Discord bot lacks a required support-category permission.");
        }
      }
      for (const role of allowedRoles) {
        const permissions = role === null ? null : category.permissionsFor(role);
        if (
          !permissions?.has([
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
          ])
        ) {
          throw new Error("A configured Discord support role cannot use a ticket category.");
        }
      }
    }
    this.guild = guild;
    this.openCategory = openCategory;
    this.closedCategory = closedCategory;
    await this.drain();
    this.syncTimer = setInterval(() => void this.drain(), syncIntervalMs);
    console.info("discord_support_ready", {
      guildId: guild.id,
      openCategoryId: openCategory.id,
      closedCategoryId: closedCategory.id,
    });
  }

  private async drain() {
    if (this.draining || this.guild === null) return;
    this.draining = true;
    try {
      for (let index = 0; index < deliveriesPerDrain; index += 1) {
        const result = await this.backend.pull();
        this.lastBackendSuccessAt = Date.now();
        if (result.state === "idle") return;
        await this.deliver(result.delivery);
      }
    } catch (error) {
      console.error("discord_support_sync_failed", { code: errorCode(error) });
    } finally {
      this.draining = false;
    }
  }

  private async deliver(delivery: DiscordSupportDelivery) {
    try {
      const { channel, messageId } =
        delivery.action.kind === "opened"
          ? await this.openChannel(delivery)
          : await this.postAction(delivery);
      await this.backend.acknowledge({
        deliveryId: delivery.id,
        claimId: delivery.claimId,
        discordChannelId: channel.id,
        discordMessageId: messageId,
      });
    } catch (error) {
      const code = errorCode(error);
      try {
        await this.backend.reject({
          deliveryId: delivery.id,
          claimId: delivery.claimId,
          errorCode: code,
        });
      } catch {
        // An expired claim becomes available to a later drain pass.
      }
      console.error("discord_support_delivery_failed", {
        deliveryId: delivery.id,
        code,
      });
    }
  }

  private async findChannel(supportCaseId: string) {
    if (this.guild === null) throw new Error("Discord support guild is unavailable.");
    const channels = await this.guild.channels.fetch();
    const topic = channelTopic(supportCaseId);
    return (
      channels.find(
        (channel): channel is TextChannel =>
          channel?.type === ChannelType.GuildText &&
          channel.topic === topic &&
          (channel.parentId === this.config.DISCORD_OPEN_CATEGORY_ID ||
            channel.parentId === this.config.DISCORD_CLOSED_CATEGORY_ID),
      ) ?? null
    );
  }

  private async openChannel(delivery: DiscordSupportDelivery) {
    if (this.guild === null || this.openCategory === null || this.closedCategory === null) {
      throw new Error("Discord support categories are unavailable.");
    }
    const existing =
      delivery.discordChannelId === undefined
        ? await this.findChannel(delivery.supportCase.id)
        : await this.fetchTextChannel(delivery.discordChannelId);
    if (existing !== null) {
      await this.placeForState(existing, delivery.supportCase.state);
      return await this.sendDelivery(existing, delivery);
    }
    const parent = isClosedState(delivery.supportCase.state)
      ? this.closedCategory
      : this.openCategory;
    const channel = await this.guild.channels.create({
      name: supportChannelName(delivery),
      type: ChannelType.GuildText,
      parent: parent.id,
      topic: channelTopic(delivery.supportCase.id),
      reason: `Code2Create support case ${delivery.supportCase.publicCode}`,
    });
    return await this.sendDelivery(channel, delivery);
  }

  private async postAction(delivery: DiscordSupportDelivery) {
    if (delivery.discordChannelId === undefined) {
      throw new Error("Discord support action has no linked channel.");
    }
    const channel = await this.fetchTextChannel(delivery.discordChannelId);
    if (channel === null) throw new Error("Discord support channel is unavailable.");
    await this.placeForState(channel, delivery.supportCase.state);
    return await this.sendDelivery(channel, delivery);
  }

  private async sendDelivery(channel: TextChannel, delivery: DiscordSupportDelivery) {
    const chunks = splitDiscordMessage(
      renderDelivery(delivery, this.config.OPERATIONS_SITE_URL),
    );
    const recentMessages = await channel.messages.fetch({ limit: 100 });
    let last: Message | null = null;
    for (const [index, chunk] of chunks.entries()) {
      const nonce = deliveryNonce(delivery.id, index);
      const existing = recentMessages.find(
        (message) =>
          message.author.id === this.client.user?.id && String(message.nonce) === nonce,
      );
      last =
        existing ??
        (await channel.send({
          content: chunk,
          allowedMentions: { parse: [] },
          nonce,
          enforceNonce: true,
        }));
    }
    if (last === null) throw new Error("Discord support action rendered no content.");
    return { channel, messageId: last.id };
  }

  private async placeForState(channel: TextChannel, state: DiscordSupportState) {
    if (this.openCategory === null || this.closedCategory === null) {
      throw new Error("Discord support categories are unavailable.");
    }
    const parent = isClosedState(state) ? this.closedCategory : this.openCategory;
    if (channel.parentId !== parent.id) {
      await channel.setParent(parent.id, {
        lockPermissions: true,
        reason: `Code2Create support case moved to ${state}`,
      });
    }
  }

  private async fetchTextChannel(channelId: string): Promise<TextChannel | null> {
    const channel = await this.client.channels.fetch(channelId);
    return channel?.type === ChannelType.GuildText &&
      channel.guildId === this.config.DISCORD_GUILD_ID
      ? channel
      : null;
  }

  private async onMessage(message: Message) {
    if (
      message.author.bot ||
      message.webhookId !== null ||
      message.guildId !== this.config.DISCORD_GUILD_ID ||
      message.channel.type !== ChannelType.GuildText ||
      (message.channel.parentId !== this.config.DISCORD_OPEN_CATEGORY_ID &&
        message.channel.parentId !== this.config.DISCORD_CLOSED_CATEGORY_ID)
    ) {
      return;
    }
    if (
      message.member === null ||
      !this.config.DISCORD_ALLOWED_ROLE_IDS.some((roleId) => message.member?.roles.cache.has(roleId))
    ) {
      await safeReact(message, "⛔");
      return;
    }
    const text = inboundMessageText(
      message.cleanContent,
      message.attachments.map((attachment) => attachment.url),
    );
    if (text.trim().length < 2) {
      await safeReact(message, "⚠️");
      return;
    }
    try {
      const result = await this.backend.reply({
        discordChannelId: message.channel.id,
        discordMessageId: message.id,
        discordUserId: message.author.id,
        discordDisplayName: message.member?.displayName ?? message.author.displayName,
        message: text,
      });
      this.lastBackendSuccessAt = Date.now();
      if (result.state === "accepted" || result.state === "already_recorded") {
        await safeReact(message, "✅");
        return;
      }
      if (result.state === "case_closed") {
        await safeReact(message, "🔒");
        return;
      }
      await safeReact(message, "❓");
    } catch (error) {
      console.error("discord_support_reply_failed", {
        messageId: message.id,
        code: errorCode(error),
      });
      await safeReact(message, "❌");
    }
  }
}

import {
  discordSupportBridgeProtocolVersion,
  type SupportCaseCategory,
  type SupportCaseState,
} from "@code2create/domain";
import { z } from "zod";

export const supportStates = ["open", "investigating", "waiting", "resolved", "closed"] as const;
export const supportCategories = [
  "identity",
  "team",
  "project_intake",
  "attendance_credential",
  "missing_scan",
  "scanner_device",
  "integration",
  "queue",
  "reviewer_device",
  "scorecard",
  "accessibility",
  "safety",
] as const satisfies readonly SupportCaseCategory[];

const actionSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum([
      "opened",
      "reporter_reply",
      "public_note",
      "internal_note",
      "state_changed",
      "owner_changed",
    ]),
    visibility: z.enum(["reporter", "internal"]),
    actorName: z.string().min(1),
    body: z.string().optional(),
    previousState: z.enum(supportStates).optional(),
    nextState: z.enum(supportStates).optional(),
    previousOwnerName: z.string().optional(),
    nextOwnerName: z.string().optional(),
    createdAt: z.number(),
  })
  .strict();

const supportCaseSchema = z
  .object({
    id: z.string().min(1),
    publicCode: z.string().min(1),
    category: z.enum(supportCategories),
    origin: z.enum(["participant", "reviewer", "staff"]),
    state: z.enum(supportStates),
    reporterName: z.string().min(1),
    contactEmail: z.email(),
    teamName: z.string().optional(),
    roundName: z.string().optional(),
    createdAt: z.number(),
  })
  .strict();

export const deliverySchema = z
  .object({
    id: z.string().min(1),
    claimId: z.uuid(),
    action: actionSchema,
    supportCase: supportCaseSchema,
    discordChannelId: z.string().regex(/^\d{6,32}$/u).optional(),
  })
  .strict();

/**
 * What the dashboard says the bridge should do. Sent with every poll, so a
 * change reaches the bot within one cycle instead of at the next restart.
 */
export const bridgeSettingsSchema = z
  .object({
    reactionsEnabled: z.boolean(),
    allowedRoleIds: z.array(z.string()),
  })
  .strict();

export type BridgeSettings = z.infer<typeof bridgeSettingsSchema>;

export const pullResponseSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("idle"), settings: bridgeSettingsSchema }).strict(),
  z
    .object({
      state: z.literal("work"),
      delivery: deliverySchema,
      settings: bridgeSettingsSchema,
    })
    .strict(),
]);

export const acknowledgementResponseSchema = z
  .object({ state: z.enum(["accepted", "already_delivered", "stale_claim"]) })
  .strict();

export const rejectResponseSchema = z
  .object({ state: z.enum(["accepted", "stale_claim"]) })
  .strict();

export const replyResponseSchema = z.discriminatedUnion("state", [
  z
    .object({ state: z.literal("accepted"), publicCode: z.string(), version: z.number().int() })
    .strict(),
  z
    .object({
      state: z.literal("already_recorded"),
      publicCode: z.string(),
      version: z.number().int(),
    })
    .strict(),
  z
    .object({ state: z.literal("case_closed"), publicCode: z.string(), version: z.number().int() })
    .strict(),
  z.object({ state: z.literal("channel_not_found") }).strict(),
]);

export const protocolVersion = discordSupportBridgeProtocolVersion;
export type DiscordSupportDelivery = z.infer<typeof deliverySchema>;
export type DiscordSupportState = SupportCaseState;

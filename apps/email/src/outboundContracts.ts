import {
  type ParticipantEmailAttachment,
  participantEmailProviders,
  participantEmailSendProtocolVersion,
} from "@code2create/domain";
import { z } from "zod";

const base64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

const attachmentSchema = z.object({
  filename: z.string().trim().min(1).max(255),
  contentType: z.string().trim().min(3).max(255),
  contentBase64: z.string().min(1).max(5_000_000).regex(base64Pattern),
  disposition: z.enum(["inline", "attachment"]),
  contentId: z.string().trim().min(1).max(255).optional(),
}).superRefine((attachment, context) => {
  if (attachment.disposition === "inline" && !attachment.contentId) {
    context.addIssue({
      code: "custom",
      message: "Inline attachments require a content ID.",
      path: ["contentId"],
    });
  }
});

export const participantEmailSendRequestSchema = z.object({
  protocolVersion: z.literal(participantEmailSendProtocolVersion),
  provider: z.enum(participantEmailProviders),
  requestId: z.string().trim().min(1).max(256),
  to: z.email().max(320),
  subject: z.string().min(1).max(998).refine((value) => !/[\r\n]/u.test(value)),
  text: z.string().min(1).max(100_000),
  html: z.string().min(1).max(500_000),
  headers: z.array(z.object({
    name: z.string().regex(/^X-Code2Create-[A-Za-z0-9-]+$/u),
    value: z.string().min(1).max(998).refine((value) => !/[\r\n]/u.test(value)),
  })).max(10),
  attachments: z.array(attachmentSchema.transform((attachment): ParticipantEmailAttachment => ({
    filename: attachment.filename, contentType: attachment.contentType,
    contentBase64: attachment.contentBase64, disposition: attachment.disposition,
    ...(attachment.contentId !== undefined ? { contentId: attachment.contentId } : {}),
  }))).max(32),
});

export type ValidatedParticipantEmailSendRequest = z.infer<
  typeof participantEmailSendRequestSchema
>;

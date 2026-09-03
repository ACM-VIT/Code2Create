import { z } from "zod";

export const maximumUpdateAssetBytes = 25 * 1_024 * 1_024;
export const maximumUpdateReleaseBytes = 10 * 1_024 * 1_024;
export const maximumUpdateActivationBytes = 1 * 1_024;
export const maximumUpdateFutureSkewMs = 5 * 60 * 1_000;

export const updateChannelSchema = z.enum(["staging", "production"]);
export type UpdateChannel = z.infer<typeof updateChannelSchema>;

export const updatePlatformSchema = z.enum(["ios", "android"]);
export type UpdatePlatform = z.infer<typeof updatePlatformSchema>;

export const runtimeVersionSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);

export const releaseIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);

export const assetKeySchema = z.string().regex(/^[a-f0-9]{64}$/u);
const httpsUrlSchema = z.url().refine((value) => value.startsWith("https://"), {
  message: "Expected an HTTPS URL",
});

export const updateAssetSchema = z.strictObject({
  hash: z
    .string()
    .min(43)
    .max(44)
    .regex(/^[A-Za-z0-9_-]+$/u),
  key: assetKeySchema,
  fileExtension: z
    .string()
    .min(2)
    .max(20)
    .regex(/^\.[A-Za-z0-9]+$/u),
  contentType: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[^\r\n]+$/u),
  url: httpsUrlSchema,
});

export const updateManifestSchema = z.strictObject({
  id: z.uuid(),
  createdAt: z.iso.datetime({ offset: true }),
  runtimeVersion: runtimeVersionSchema,
  assets: z.array(updateAssetSchema).max(2_000),
  launchAsset: updateAssetSchema,
  metadata: z.record(z.string(), z.json()),
  extra: z.strictObject({
    expoClient: z.json(),
  }),
});

const signatureSchema = z
  .string()
  .min(20)
  .max(16_384)
  .regex(/^[^\r\n]+$/u);

export const signedPayloadSchema = z.strictObject({
  body: z.string().min(2).max(4_000_000),
  signature: signatureSchema,
});

export type SignedPayload = z.infer<typeof signedPayloadSchema>;

const releaseRecordBase = z.strictObject({
  schemaVersion: z.literal(1),
  channel: updateChannelSchema,
  runtimeVersion: runtimeVersionSchema,
  releaseId: releaseIdSchema,
  createdAt: z.iso.datetime({ offset: true }),
  noUpdate: signedPayloadSchema,
});

export const updateReleaseRecordSchema = releaseRecordBase.extend({
  kind: z.literal("update"),
  platforms: z.strictObject({
    ios: z.strictObject({
      updateId: z.uuid(),
      manifest: signedPayloadSchema,
    }),
    android: z.strictObject({
      updateId: z.uuid(),
      manifest: signedPayloadSchema,
    }),
  }),
});

export const rollbackReleaseRecordSchema = releaseRecordBase.extend({
  kind: z.literal("rollback"),
  directive: signedPayloadSchema,
});

export const releaseRecordSchema = z.discriminatedUnion("kind", [
  updateReleaseRecordSchema,
  rollbackReleaseRecordSchema,
]);

export type ReleaseRecord = z.infer<typeof releaseRecordSchema>;
export type UpdateReleaseRecord = z.infer<typeof updateReleaseRecordSchema>;

export const activationRequestSchema = z.strictObject({
  expectedCurrentReleaseId: releaseIdSchema.nullable(),
});

export const currentReleaseResponseSchema = z.strictObject({
  currentReleaseId: releaseIdSchema.nullable(),
  etag: z.string().min(1).nullable(),
});

export const updateHealthResponseSchema = z.strictObject({
  service: z.literal("code2create-updates"),
  channel: updateChannelSchema,
});

export const noUpdateDirectiveSchema = z.strictObject({
  type: z.literal("noUpdateAvailable"),
});

export const rollbackDirectiveSchema = z.strictObject({
  type: z.literal("rollBackToEmbedded"),
  parameters: z.strictObject({
    commitTime: z.iso.datetime({ offset: true }),
  }),
});

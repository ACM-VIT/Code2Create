import { z } from "zod";

import { storedOperationResult } from "./operations";

const configurationDraftOperationResult = z
  .object({
    version: z.number().int().positive(),
    checksum: z.string().min(1),
    changed: z.boolean(),
  })
  .strict();

const configurationPublicationOperationResult = z
  .object({
    version: z.number().int().positive(),
    eventVersion: z.number().int().positive(),
  })
  .strict();

type ConfigurationDraftOperationResult = z.infer<typeof configurationDraftOperationResult>;
type ConfigurationPublicationOperationResult = z.infer<
  typeof configurationPublicationOperationResult
>;

export function storedConfigurationResult<Result>(
  resultJson: string | undefined,
  label: string,
  schema: z.ZodType<Result>,
) {
  return storedOperationResult(resultJson, label, schema);
}

export function configurationDraftResultJson(result: ConfigurationDraftOperationResult) {
  return JSON.stringify(result);
}

export function storedConfigurationDraftResult(resultJson: string | undefined, label: string) {
  return storedConfigurationResult(resultJson, label, configurationDraftOperationResult);
}

export function configurationPublicationResultJson(
  result: ConfigurationPublicationOperationResult,
) {
  return JSON.stringify(result);
}

export function storedConfigurationPublicationResult(
  resultJson: string | undefined,
  label: string,
) {
  return storedConfigurationResult(resultJson, label, configurationPublicationOperationResult);
}

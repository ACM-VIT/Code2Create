"use node";

import {
  PinpointSMSVoiceV2Client,
  SendTextMessageCommand,
  type SendTextMessageCommandInput,
} from "@aws-sdk/client-pinpoint-sms-voice-v2";

import { phoneVerificationLifetimeMs } from "./phoneVerification";

type SmsEnvironment = Record<string, string | undefined>;

export type AwsSmsConfiguration = {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  originationIdentity?: string;
  configurationSetName?: string;
  entityId?: string;
  templateId?: string;
  messageTemplate: string;
};

const awsRegion = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u;
const registeredIndiaRegions = new Set(["ap-south-1", "ap-south-2"]);
const defaultMessageTemplate =
  "Your Code2Create verification code is {{code}}. It expires in 10 minutes. Do not share it.";

function required(environment: SmsEnvironment, name: string) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required for phone verification.`);
  return value;
}

function optional(environment: SmsEnvironment, name: string) {
  const value = environment[name]?.trim();
  return value || undefined;
}

export function readAwsSmsConfiguration(
  environment: SmsEnvironment = process.env,
): AwsSmsConfiguration {
  const region = required(environment, "SMS_AWS_REGION");
  if (!awsRegion.test(region)) {
    throw new Error("SMS_AWS_REGION is not a valid AWS region.");
  }
  const entityId = optional(environment, "SMS_AWS_ENTITY_ID");
  const templateId = optional(environment, "SMS_AWS_TEMPLATE_ID");
  if (Boolean(entityId) !== Boolean(templateId)) {
    throw new Error("SMS_AWS_ENTITY_ID and SMS_AWS_TEMPLATE_ID must be configured together.");
  }
  const originationIdentity = optional(environment, "SMS_AWS_ORIGINATION_IDENTITY");
  if (entityId && !originationIdentity) {
    throw new Error("SMS_AWS_ORIGINATION_IDENTITY is required for a registered India SMS route.");
  }
  if (entityId && !registeredIndiaRegions.has(region)) {
    throw new Error("Registered India SMS routes must use ap-south-1 or ap-south-2.");
  }
  // The code may appear more than once: origin-bound autofill (WebOTP on
  // Android, domain-bound codes on iOS) needs a final line of the form
  // "@c2c.acmvit.in #{{code}}" after the human-readable sentence.
  const messageTemplate =
    optional(environment, "PHONE_VERIFICATION_MESSAGE_TEMPLATE") ?? defaultMessageTemplate;
  if (messageTemplate.length > 320 || !messageTemplate.includes("{{code}}")) {
    throw new Error(
      "PHONE_VERIFICATION_MESSAGE_TEMPLATE must contain {{code}} and stay under 320 characters.",
    );
  }
  const sessionToken = optional(environment, "SMS_AWS_SESSION_TOKEN");
  const configurationSetName = optional(environment, "SMS_AWS_CONFIGURATION_SET");
  return {
    region,
    accessKeyId: required(environment, "SMS_AWS_ACCESS_KEY_ID"),
    secretAccessKey: required(environment, "SMS_AWS_SECRET_ACCESS_KEY"),
    ...(sessionToken ? { sessionToken } : {}),
    ...(originationIdentity ? { originationIdentity } : {}),
    ...(configurationSetName ? { configurationSetName } : {}),
    ...(entityId ? { entityId } : {}),
    ...(templateId ? { templateId } : {}),
    messageTemplate,
  };
}

export function buildPhoneVerificationMessage(template: string, code: string) {
  return template.replaceAll("{{code}}", code);
}

export function phoneVerificationSmsRequest(args: {
  configuration: AwsSmsConfiguration;
  phone: string;
  code: string;
}): SendTextMessageCommandInput {
  const { configuration } = args;
  const indiaRegistration =
    args.phone.startsWith("+91") && configuration.entityId && configuration.templateId
      ? {
          IN_ENTITY_ID: configuration.entityId,
          IN_TEMPLATE_ID: configuration.templateId,
        }
      : undefined;
  return {
    DestinationPhoneNumber: args.phone,
    MessageBody: buildPhoneVerificationMessage(configuration.messageTemplate, args.code),
    MessageType: "TRANSACTIONAL",
    TimeToLive: Math.floor(phoneVerificationLifetimeMs / 1_000),
    ...(configuration.originationIdentity
      ? { OriginationIdentity: configuration.originationIdentity }
      : {}),
    ...(configuration.configurationSetName
      ? { ConfigurationSetName: configuration.configurationSetName }
      : {}),
    ...(indiaRegistration ? { DestinationCountryParameters: indiaRegistration } : {}),
  };
}

export async function sendPhoneVerificationSms(args: { phone: string; code: string }) {
  const configuration = readAwsSmsConfiguration();
  const client = new PinpointSMSVoiceV2Client({
    region: configuration.region,
    credentials: {
      accessKeyId: configuration.accessKeyId,
      secretAccessKey: configuration.secretAccessKey,
      ...(configuration.sessionToken ? { sessionToken: configuration.sessionToken } : {}),
    },
    // SendTextMessage has no caller idempotency token. A timeout may be ambiguous,
    // so only an explicit participant resend is allowed to create another SMS.
    maxAttempts: 1,
  });
  const response = await client.send(
    new SendTextMessageCommand(phoneVerificationSmsRequest({ ...args, configuration })),
  );
  if (!response.MessageId) throw new Error("AWS accepted no phone verification message.");
  return response.MessageId;
}

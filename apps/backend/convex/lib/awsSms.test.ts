import { describe, expect, test } from "vitest";

import {
  phoneVerificationSmsRequest,
  readAwsSmsConfiguration,
} from "./awsSms";

const baseEnvironment = {
  SMS_AWS_REGION: "ap-south-1",
  SMS_AWS_ACCESS_KEY_ID: "test-access-key",
  SMS_AWS_SECRET_ACCESS_KEY: "test-secret-key",
};

describe("AWS phone verification SMS", () => {
  test("builds a transactional request without inventing India registration", () => {
    const configuration = readAwsSmsConfiguration(baseEnvironment);
    expect(phoneVerificationSmsRequest({
      configuration,
      phone: "+919000000000",
      code: "123456",
    })).toEqual({
      DestinationPhoneNumber: "+919000000000",
      MessageBody:
        "Your Code2Create verification code is 123456. It expires in 10 minutes. Do not share it.",
      MessageType: "TRANSACTIONAL",
      TimeToLive: 600,
    });
  });

  test("adds DLT identifiers only for an Indian destination", () => {
    const configuration = readAwsSmsConfiguration({
      ...baseEnvironment,
      SMS_AWS_ORIGINATION_IDENTITY: "C2CREATE",
      SMS_AWS_ENTITY_ID: "entity-1",
      SMS_AWS_TEMPLATE_ID: "template-1",
    });
    expect(phoneVerificationSmsRequest({
      configuration,
      phone: "+919000000000",
      code: "654321",
    })).toMatchObject({
      OriginationIdentity: "C2CREATE",
      DestinationCountryParameters: {
        IN_ENTITY_ID: "entity-1",
        IN_TEMPLATE_ID: "template-1",
      },
    });
    expect(phoneVerificationSmsRequest({
      configuration,
      phone: "+14155550100",
      code: "654321",
    })).not.toHaveProperty("DestinationCountryParameters");
  });

  test("rejects partial or unusable registered-India configuration", () => {
    expect(() => readAwsSmsConfiguration({
      ...baseEnvironment,
      SMS_AWS_ENTITY_ID: "entity-1",
    })).toThrow("must be configured together");
    expect(() => readAwsSmsConfiguration({
      ...baseEnvironment,
      SMS_AWS_ENTITY_ID: "entity-1",
      SMS_AWS_TEMPLATE_ID: "template-1",
    })).toThrow("SMS_AWS_ORIGINATION_IDENTITY");
    expect(() => readAwsSmsConfiguration({
      ...baseEnvironment,
      SMS_AWS_REGION: "eu-west-1",
      SMS_AWS_ORIGINATION_IDENTITY: "C2CREATE",
      SMS_AWS_ENTITY_ID: "entity-1",
      SMS_AWS_TEMPLATE_ID: "template-1",
    })).toThrow("ap-south-1 or ap-south-2");
  });

  test("requires exactly one code placeholder in a bounded message", () => {
    expect(() => readAwsSmsConfiguration({
      ...baseEnvironment,
      PHONE_VERIFICATION_MESSAGE_TEMPLATE: "Code {{code}} and {{code}}",
    })).toThrow("contain {{code}} exactly once");
    expect(() => readAwsSmsConfiguration({
      ...baseEnvironment,
      PHONE_VERIFICATION_MESSAGE_TEMPLATE: "No verification value",
    })).toThrow("contain {{code}} exactly once");
  });
});

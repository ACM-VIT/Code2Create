import { describe, expect, test } from "vitest";

import {
  constantTimeDigestEqual,
  normalizePhoneVerificationCode,
  phoneVerificationCodeDigest,
  requirePhoneVerificationSecret,
} from "./phoneVerification";

const secret = "A".repeat(43);

describe("phone verification codes", () => {
  test("normalizes pasted codes without accepting a partial value", () => {
    expect(normalizePhoneVerificationCode(" 12-34 56 ")).toBe("123456");
    expect(normalizePhoneVerificationCode("1234567")).toBe("123456");
  });

  test("binds each digest to its verification, phone, and code", () => {
    const digest = phoneVerificationCodeDigest({
      secret,
      verificationId: "verification-1",
      phone: "+919000000000",
      code: "123456",
    });
    expect(digest).toHaveLength(64);
    expect(constantTimeDigestEqual(digest, digest)).toBe(true);
    expect(constantTimeDigestEqual(
      digest,
      phoneVerificationCodeDigest({
        secret,
        verificationId: "verification-2",
        phone: "+919000000000",
        code: "123456",
      }),
    )).toBe(false);
    expect(constantTimeDigestEqual(digest, `${digest}0`)).toBe(false);
  });

  test("requires a full 32-byte base64url HMAC secret", () => {
    expect(requirePhoneVerificationSecret({
      PHONE_VERIFICATION_HMAC_SECRET: secret,
    })).toBe(secret);
    expect(() => requirePhoneVerificationSecret({
      PHONE_VERIFICATION_HMAC_SECRET: "too-short",
    })).toThrow("base64url-encoded 32-byte secret");
  });
});

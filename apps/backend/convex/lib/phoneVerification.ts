import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

export const phoneVerificationCodeLength = 6;
export const phoneVerificationLifetimeMs = 10 * 60_000;
export const phoneVerificationResendDelayMs = 60_000;
export const phoneVerificationMaximumAttempts = 5;
export const phoneVerificationMaximumHourlyRequests = 5;
export const phoneVerificationRequestWindowMs = 60 * 60_000;

const base64UrlSecret = /^[A-Za-z0-9_-]{43}$/u;
const verificationCode = /^\d{6}$/u;

export function requirePhoneVerificationSecret(
  environment: Record<string, string | undefined> = process.env,
) {
  const secret = environment.PHONE_VERIFICATION_HMAC_SECRET?.trim();
  if (!secret || !base64UrlSecret.test(secret)) {
    throw new Error("PHONE_VERIFICATION_HMAC_SECRET must be one base64url-encoded 32-byte secret.");
  }
  return secret;
}

export function normalizePhoneVerificationCode(value: string) {
  return value.replace(/\D/gu, "").slice(0, phoneVerificationCodeLength);
}

export function isPhoneVerificationCode(value: string) {
  return verificationCode.test(value);
}

export function phoneVerificationCodeDigest(args: {
  secret: string;
  verificationId: string;
  phone: string;
  code: string;
}) {
  if (!isPhoneVerificationCode(args.code)) {
    throw new Error("The phone verification code must contain exactly six digits.");
  }
  const payload = [
    "code2create-phone-verification-v1",
    args.verificationId,
    args.phone,
    args.code,
  ].join("\n");
  return bytesToHex(hmac(sha256, utf8ToBytes(args.secret), utf8ToBytes(payload)));
}

export function constantTimeDigestEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

export function maskedPhone(phone: string) {
  return `••••${phone.slice(-4)}`;
}

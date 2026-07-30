import { cookies } from "next/headers";

const encoder = new TextEncoder();

export const sessionCookie = {
  name: "c2c_specs_session",
  maxAge: 60 * 60 * 12,
  options: {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
  },
};

function bytesToBase64Url(bytes: Uint8Array) {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function signature(payload: string, secret: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return bytesToBase64Url(new Uint8Array(signed));
}

async function constantTimeEqual(left: string, right: string) {
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const a = new Uint8Array(leftHash);
  const b = new Uint8Array(rightHash);
  let mismatch = a.length ^ b.length;
  for (let index = 0; index < a.length; index += 1) {
    mismatch |= a[index] ^ b[index];
  }
  return mismatch === 0;
}

export function passwordsMatch(supplied: string, expected: string) {
  return constantTimeEqual(supplied, expected);
}

export async function createSessionValue(secret: string) {
  const expiresAt = String(Date.now() + sessionCookie.maxAge * 1000);
  return `${expiresAt}.${await signature(expiresAt, secret)}`;
}

export async function isAuthenticated() {
  const secret = process.env.AUTH_SECRET;
  if (!secret) return false;

  const value = (await cookies()).get(sessionCookie.name)?.value;
  if (!value) return false;

  const [expiresAt, suppliedSignature] = value.split(".");
  if (!expiresAt || !suppliedSignature || Number(expiresAt) <= Date.now()) {
    return false;
  }

  const expectedSignature = await signature(expiresAt, secret);
  return constantTimeEqual(suppliedSignature, expectedSignature);
}

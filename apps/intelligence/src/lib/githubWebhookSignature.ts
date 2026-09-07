const encoder = new TextEncoder();

function hexBytes(value: string) {
  if (value.length % 2 !== 0 || !/^[0-9a-f]+$/u.test(value)) return null;
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function equalBytes(left: Uint8Array, right: Uint8Array) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

/** Validates GitHub's `X-Hub-Signature-256` over the unmodified request bytes. */
export async function verifyGithubWebhookSignature(
  secret: string,
  body: Uint8Array,
  header: string,
) {
  if (!header.startsWith("sha256=")) return false;
  const received = hexBytes(header.slice("sha256=".length).toLowerCase());
  if (!received || received.length !== 32) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, Uint8Array.from(body)));
  return equalBytes(received, expected);
}

/** Produces GitHub's signature format; used by tests and local webhook replay. */
export async function githubWebhookSignature(secret: string, body: Uint8Array) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, Uint8Array.from(body)));
  return `sha256=${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export async function payloadHash(body: Uint8Array) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(body)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

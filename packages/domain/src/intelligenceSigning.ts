const encoder = new TextEncoder();

function signatureInput(context: string, timestamp: string, body: string) {
  return `${context}\n${timestamp}\n${body}`;
}

function bytesToHex(bytes: Uint8Array) {
  let result = "";
  for (const byte of bytes) result += byte.toString(16).padStart(2, "0");
  return result;
}

function hexToBytes(value: string) {
  if (!/^[a-f0-9]{64}$/i.test(value)) return null;
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    const pair = value.slice(index * 2, index * 2 + 2);
    const parsed = Number.parseInt(pair, 16);
    if (!Number.isFinite(parsed)) return null;
    bytes[index] = parsed;
  }
  return bytes;
}

export async function signServiceBody(args: {
  context: string;
  secret: string;
  timestamp: string;
  body: string;
}) {
  const secret = encoder.encode(args.secret);
  if (secret.byteLength < 32) {
    throw new Error("Service signing secrets must be at least 32 UTF-8 bytes.");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    secret,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(signatureInput(args.context, args.timestamp, args.body)),
  );
  return bytesToHex(new Uint8Array(signature));
}

export async function verifyServiceBody(args: {
  context: string;
  secret: string;
  timestamp: string;
  signature: string;
  body: string;
  now: number;
  maximumAgeMs: number;
}) {
  const timestamp = Number(args.timestamp);
  if (
    !Number.isSafeInteger(timestamp) ||
    args.maximumAgeMs <= 0 ||
    Math.abs(args.now - timestamp) > args.maximumAgeMs
  ) {
    return false;
  }
  const provided = hexToBytes(args.signature);
  if (!provided) return false;
  const expectedHex = await signServiceBody(args);
  const expected = hexToBytes(expectedHex);
  if (!expected || expected.length !== provided.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    const expectedByte = expected[index];
    const providedByte = provided[index];
    if (expectedByte === undefined || providedByte === undefined) return false;
    difference |= expectedByte ^ providedByte;
  }
  return difference === 0;
}

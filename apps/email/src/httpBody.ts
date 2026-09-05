export class HttpBodyTooLargeError extends Error {
  constructor() {
    super("The HTTP body is too large.");
    this.name = "HttpBodyTooLargeError";
  }
}

type BodyReadResult =
  | { done: true }
  | { done: false; value: Uint8Array };

function parseBodyReadResult(value: unknown): BodyReadResult {
  if (typeof value !== "object" || value === null || !("done" in value)) {
    throw new Error("The HTTP body stream returned an invalid result.");
  }
  if (value.done === true) return { done: true };
  if (value.done !== false || !("value" in value) || !(value.value instanceof Uint8Array)) {
    throw new Error("The HTTP body stream returned invalid bytes.");
  }
  return { done: false, value: value.value };
}

async function readBoundedBytes(message: Request | Response, maximumBytes: number) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new RangeError("The maximum HTTP body size must be a positive integer.");
  }
  const declaredLength = message.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (Number.isFinite(parsedLength) && parsedLength > maximumBytes) {
      throw new HttpBodyTooLargeError();
    }
  }
  if (!message.body) {
    const bytes = new Uint8Array(await message.arrayBuffer());
    if (bytes.byteLength > maximumBytes) throw new HttpBodyTooLargeError();
    return bytes;
  }
  const reader = message.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const rawResult: unknown = await reader.read();
    const result = parseBodyReadResult(rawResult);
    if (result.done) break;
    totalBytes += result.value.byteLength;
    if (totalBytes > maximumBytes) {
      try {
        await reader.cancel();
      } catch {
        // The size violation remains the actionable error.
      }
      throw new HttpBodyTooLargeError();
    }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function readBoundedRequestText(request: Request, maximumBytes: number) {
  return new TextDecoder().decode(await readBoundedBytes(request, maximumBytes));
}

export async function readBoundedResponseText(response: Response, maximumBytes: number) {
  return new TextDecoder().decode(await readBoundedBytes(response, maximumBytes));
}

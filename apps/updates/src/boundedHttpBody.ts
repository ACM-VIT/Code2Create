export class HttpBodyTooLargeError extends Error {
  constructor() {
    super("The HTTP body is too large.");
    this.name = "HttpBodyTooLargeError";
  }
}

export class HttpBodyNotJsonError extends Error {
  constructor() {
    super("The HTTP body is not JSON.");
    this.name = "HttpBodyNotJsonError";
  }
}

export class HttpBodyInvalidJsonError extends Error {
  constructor() {
    super("The HTTP body contains invalid JSON.");
    this.name = "HttpBodyInvalidJsonError";
  }
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
  if (message.body === null) {
    const bytes = new Uint8Array(await message.arrayBuffer());
    if (bytes.byteLength > maximumBytes) throw new HttpBodyTooLargeError();
    return bytes;
  }
  const reader = message.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    if (result.value === undefined) continue;
    totalBytes += result.value.byteLength;
    if (totalBytes > maximumBytes) {
      try {
        await reader.cancel();
      } catch {
        // The size violation remains the actionable error even if cancellation fails.
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

export async function readBoundedRequestBytes(request: Request, maximumBytes: number) {
  return (await readBoundedBytes(request, maximumBytes)).buffer;
}

export async function readBoundedRequestJson(
  request: Request,
  maximumBytes: number,
): Promise<unknown> {
  requireJsonContentType(request.headers);
  return parseJson(new TextDecoder().decode(await readBoundedBytes(request, maximumBytes)));
}

export async function readBoundedResponseText(response: Response, maximumBytes: number) {
  return new TextDecoder().decode(await readBoundedBytes(response, maximumBytes));
}

export async function readBoundedJsonResponse(
  response: Response,
  maximumBytes: number,
): Promise<unknown> {
  requireJsonContentType(response.headers);
  return parseJson(await readBoundedResponseText(response, maximumBytes));
}

function requireJsonContentType(headers: Headers) {
  const contentType = headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (contentType !== "application/json" && contentType?.endsWith("+json") !== true) {
    throw new HttpBodyNotJsonError();
  }
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw new HttpBodyInvalidJsonError();
  }
}

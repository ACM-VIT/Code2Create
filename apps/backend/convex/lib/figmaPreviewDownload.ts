import {
  HttpBodyTooLargeError,
  readBoundedResponseBytes,
} from "./boundedHttpBody";

const figmaPreviewHost = "s3-alpha-sig.figma.com";
const previewDownloadTimeoutMs = 30_000;

export class FigmaPreviewDownloadError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "FigmaPreviewDownloadError";
    this.code = code;
  }
}

export function validFigmaPreviewUrl(value: string) {
  if (value.length > 8_192) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== figmaPreviewHost ||
    url.port ||
    url.username ||
    url.password
  ) {
    return null;
  }
  return url;
}

export async function downloadFigmaPreview(value: string, maximumBytes: number) {
  const url = validFigmaPreviewUrl(value);
  if (!url) throw new FigmaPreviewDownloadError("preview_url_invalid");
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Accept: "image/png" },
      redirect: "error",
      signal: AbortSignal.timeout(previewDownloadTimeoutMs),
    });
  } catch {
    throw new FigmaPreviewDownloadError("preview_download_failed");
  }
  if (!response.ok || !validFigmaPreviewUrl(response.url)) {
    throw new FigmaPreviewDownloadError("preview_download_failed");
  }
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (contentType !== "image/png" && contentType !== "application/octet-stream") {
    throw new FigmaPreviewDownloadError("preview_content_type_invalid");
  }
  try {
    return await readBoundedResponseBytes(response, maximumBytes);
  } catch (caught) {
    if (caught instanceof HttpBodyTooLargeError) {
      throw new FigmaPreviewDownloadError("preview_too_large");
    }
    throw caught;
  }
}

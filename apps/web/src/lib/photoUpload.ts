export const photoMaximumBytes = 50 * 1024 * 1024;
export const photoAccept = "image/jpeg,image/png,image/webp,image/avif";

export function validatePhotoFile(file: Pick<File, "name" | "type" | "size">) {
  if (!photoAccept.split(",").includes(file.type))
    return "Choose a JPEG, PNG, WebP, or AVIF photo.";
  if (file.size === 0 || file.size > photoMaximumBytes)
    return "Each photo must be between 1 byte and 50 MB.";
  if (
    file.name.length > 180 ||
    [...file.name].some(
      (char) =>
        char.charCodeAt(0) < 32 ||
        char.charCodeAt(0) === 127 ||
        char === "/" ||
        char === "\\",
    )
  )
    return "The filename is too long or contains unsupported characters.";
  return null;
}

export async function photoChecksum(file: File) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    await file.arrayBuffer(),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function uploadOriginal(
  url: string,
  file: File,
  signal: AbortSignal,
  onProgress: (percent: number) => void,
) {
  return new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest();
    const abort = () => request.abort();
    request.open("PUT", url);
    request.setRequestHeader("Content-Type", file.type);
    request.timeout = 15 * 60_000;
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable)
        onProgress(Math.round((event.loaded / event.total) * 100));
    });
    request.addEventListener("load", () =>
      request.status >= 200 && request.status < 300
        ? resolve()
        : reject(new Error("The upload did not finish. Retry this photo.")),
    );
    request.addEventListener("error", () =>
      reject(new Error("The connection was interrupted. Retry this photo.")),
    );
    request.addEventListener("timeout", () =>
      reject(new Error("The upload timed out. Retry this photo.")),
    );
    request.addEventListener("abort", () =>
      reject(new Error("Upload cancelled.")),
    );
    request.addEventListener("loadend", () =>
      signal.removeEventListener("abort", abort),
    );
    if (signal.aborted) {
      reject(new Error("Upload cancelled."));
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    request.send(file);
  });
}

export function photoSize(bytes: number) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

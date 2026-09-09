import { Zip, ZipPassThrough } from "fflate";

import {
  selectionMaximumBytes,
  selectionMaximumCount,
  selectionLimitMessage,
} from "./photoSelection.ts";

export async function downloadPhotoArchive<
  T extends { fileName: string; byteCount: number },
>(
  photos: T[],
  getUrl: (photo: T) => Promise<string>,
  signal: AbortSignal,
  onProgress: (completed: number) => void,
): Promise<Blob> {
  if (
    !photos.length ||
    photos.length > selectionMaximumCount ||
    photos.reduce((sum, photo) => sum + photo.byteCount, 0) >
      selectionMaximumBytes
  ) {
    throw new Error(selectionLimitMessage);
  }
  const chunks: BlobPart[] = [];
  let zipError: Error | null = null;
  const zip = new Zip((error, data) => {
    if (error) zipError = error;
    else chunks.push(new Uint8Array(data));
  });
  try {
    for (const [index, photo] of photos.entries()) {
      signal.throwIfAborted();
      const response = await fetch(await getUrl(photo), { signal });
      if (!response.ok || !response.body)
        throw new Error(`Could not download ${photo.fileName}. Please retry.`);
      const safeName = photo.fileName.replace(/[\\/]/g, "_");
      // Prefix avoids duplicate filenames; pass-through retains every original byte.
      const entry = new ZipPassThrough(
        `${String(index + 1).padStart(3, "0")}-${safeName}`,
      );
      zip.add(entry);
      const reader = response.body.getReader();
      let received = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          received += value.byteLength;
          if (received > photo.byteCount)
            throw new Error(
              "The original size changed. Reload the gallery and retry.",
            );
          entry.push(value);
          if (zipError)
            throw new Error("Could not create the photo ZIP.", {
              cause: zipError,
            });
        }
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
      if (received !== photo.byteCount)
        throw new Error(
          `Incomplete download: ${photo.fileName}. Please retry.`,
        );
      entry.push(new Uint8Array(), true);
      onProgress(index + 1);
    }
    zip.end();
    if (zipError)
      throw new Error("Could not create the photo ZIP.", { cause: zipError });
    return new Blob(chunks, { type: "application/zip" });
  } finally {
    zip.terminate();
  }
}

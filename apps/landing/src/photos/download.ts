import { photoUrl, type GalleryPhoto } from "./catalog.js";

declare global {
  interface Window {
    showSaveFilePicker?: (options: {
      suggestedName: string;
      types: { description: string; accept: Record<string, string[]> }[];
    }) => Promise<{ createWritable(): Promise<WritableStream<Uint8Array>> }>;
  }
}

// Browsers without a file writer need to hold the ZIP until it is ready.
const BUFFER_LIMIT = 250 * 1024 * 1024;

export async function downloadPhotos(
  photos: GalleryPhoto[],
  signal: AbortSignal,
  onProgress: (completed: number) => void,
) {
  const handle = await window.showSaveFilePicker?.({
    suggestedName: "code2create-photos.zip",
    types: [
      { description: "Photo archive", accept: { "application/zip": [".zip"] } },
    ],
  });
  signal.throwIfAborted();
  const { downloadZip } = await import("client-zip");
  let bytes = 0;
  async function* originals() {
    for (const [index, photo] of photos.entries()) {
      signal.throwIfAborted();
      const response = await fetch(photoUrl(photo.key), { signal });
      if (!response.ok || !response.body)
        throw new Error("A photo couldn’t download. Please try again.");
      const input = response.body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            bytes += chunk.byteLength;
            if (!handle && bytes > BUFFER_LIMIT) {
              throw new Error(
                "This selection is too large for this browser. Try fewer photos, or use desktop Chrome or Edge.",
              );
            }
            controller.enqueue(chunk);
          },
        }),
      );
      // Numbering preserves duplicate camera filenames without overwriting files.
      yield {
        name: `${String(index + 1).padStart(3, "0")}-${photo.name.replace(/[\\/]/g, "_")}`,
        input,
      };
      onProgress(index + 1);
    }
  }
  const archive = downloadZip(originals());
  if (handle) {
    const destination = await handle.createWritable();
    if (!archive.body) throw new Error("Couldn’t create the archive.");
    await archive.body.pipeTo(destination, { signal });
  } else {
    const blob = await archive.blob();
    signal.throwIfAborted();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "code2create-photos.zip";
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

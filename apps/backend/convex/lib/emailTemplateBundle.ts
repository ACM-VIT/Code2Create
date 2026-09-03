import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { participantEmailTemplateZipMaximumBytes } from "@code2create/domain";
import { Unzip, UnzipInflate, UnzipPassThrough } from "fflate";

const maximumEmailTemplateHtmlBytes = 250_000;
const maximumEmailTemplateAssetBytes = 3_200_000;
const maximumEmailTemplateFiles = 25;
const maximumArchiveEntries = 64;

const contentTypes: Record<string, string> = {
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  pdf: "application/pdf",
  png: "image/png",
  webp: "image/webp",
};

type ArchiveEntry = {
  path: string;
  bytes: Uint8Array;
};

export type ImportedEmailTemplateAsset = {
  fileName: string;
  contentType: string;
  contentId: string;
  disposition: "inline" | "attachment";
  bytes: Uint8Array;
};

export type ImportedEmailTemplateBundle = {
  html: string;
  htmlFileName: string;
  assets: ImportedEmailTemplateAsset[];
};

export class EmailTemplateBundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmailTemplateBundleError";
  }
}

function invalidBundle(message: string): never {
  throw new EmailTemplateBundleError(message);
}

function normalizedEntryPath(value: string) {
  const path = value.replaceAll("\\", "/").replace(/^\.\//u, "");
  const parts = path.split("/");
  if (
    !path ||
    path.length > 240 ||
    path.startsWith("/") ||
    /^[A-Za-z]:\//u.test(path) ||
    [...path].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127;
    }) ||
    parts.some(
      (part, index) =>
        part === "." || part === ".." || (part === "" && index !== parts.length - 1),
    )
  ) {
    invalidBundle("The ZIP contains an unsafe file path.");
  }
  return path;
}

function baseName(path: string) {
  return path.split("/").at(-1) ?? "";
}

function ignoredEntry(path: string) {
  return path.endsWith("/") || path.startsWith("__MACOSX/") || baseName(path) === ".DS_Store";
}

function combineChunks(chunks: Uint8Array[], size: number) {
  const combined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

async function extractArchive(bytes: Uint8Array): Promise<ArchiveEntry[]> {
  return await new Promise((resolve, reject) => {
    const entries: ArchiveEntry[] = [];
    const names = new Set<string>();
    const active = new Set<() => void>();
    let archiveEntries = 0;
    let usefulEntries = 0;
    let declaredBytes = 0;
    let extractedBytes = 0;
    let pending = 0;
    let inputFinished = false;
    let settled = false;

    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      for (const terminate of active) terminate();
      reject(
        error instanceof EmailTemplateBundleError
          ? error
          : new EmailTemplateBundleError("The selected file is not a readable ZIP archive."),
      );
    };
    const finish = () => {
      if (!settled && inputFinished && pending === 0) {
        settled = true;
        resolve(entries);
      }
    };
    const archive = new Unzip((file) => {
      if (settled) {
        file.terminate();
        return;
      }
      archiveEntries += 1;
      if (archiveEntries > maximumArchiveEntries) {
        file.terminate();
        fail(new EmailTemplateBundleError(`The ZIP may contain at most ${maximumArchiveEntries} entries.`));
        return;
      }
      let path: string;
      try {
        path = normalizedEntryPath(file.name);
      } catch (error) {
        file.terminate();
        fail(error);
        return;
      }
      if (file.originalSize !== undefined) {
        declaredBytes += file.originalSize;
        if (
          file.originalSize > maximumEmailTemplateHtmlBytes + maximumEmailTemplateAssetBytes ||
          declaredBytes > maximumEmailTemplateHtmlBytes + maximumEmailTemplateAssetBytes
        ) {
          file.terminate();
          fail(new EmailTemplateBundleError("The uncompressed template package is too large."));
          return;
        }
      }
      const ignored = ignoredEntry(path);
      if (!ignored) {
        const comparableName = path.toLocaleLowerCase("en");
        if (names.has(comparableName)) {
          file.terminate();
          fail(new EmailTemplateBundleError(`The ZIP contains a duplicate file named ${path}.`));
          return;
        }
        usefulEntries += 1;
        if (usefulEntries > maximumEmailTemplateFiles) {
          file.terminate();
          fail(
            new EmailTemplateBundleError(
              `The ZIP may contain one HTML file and up to ${maximumEmailTemplateFiles - 1} assets.`,
            ),
          );
          return;
        }
        names.add(comparableName);
      }
      pending += 1;
      const chunks: Uint8Array[] = [];
      let fileBytes = 0;
      active.add(file.terminate);
      file.ondata = (error, chunk, final) => {
        if (settled) return;
        if (error) {
          fail(error);
          return;
        }
        fileBytes += chunk.byteLength;
        extractedBytes += chunk.byteLength;
        if (extractedBytes > maximumEmailTemplateHtmlBytes + maximumEmailTemplateAssetBytes) {
          file.terminate();
          fail(new EmailTemplateBundleError("The uncompressed template package is too large."));
          return;
        }
        if (!ignored && chunk.byteLength > 0) chunks.push(chunk.slice());
        if (final) {
          active.delete(file.terminate);
          if (!ignored) entries.push({ path, bytes: combineChunks(chunks, fileBytes) });
          pending -= 1;
          finish();
        }
      };
      try {
        file.start();
      } catch (error) {
        fail(error);
      }
    });
    archive.register(UnzipInflate);
    archive.register(UnzipPassThrough);
    try {
      archive.push(bytes, true);
      inputFinished = true;
      finish();
    } catch (error) {
      fail(error);
    }
  });
}

function extension(path: string) {
  return path.split(".").at(-1)?.toLocaleLowerCase("en") ?? "";
}

function decodeHtml(bytes: Uint8Array) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    invalidBundle("The template HTML must use UTF-8 text.");
  }
}

function validateAssetBytes(fileName: string, bytes: Uint8Array, contentType: string) {
  const decoder = new TextDecoder();
  const valid =
    contentType === "image/png"
      ? bytes.byteLength >= 8 &&
        [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every(
          (byte, index) => bytes[index] === byte,
        )
      : contentType === "image/jpeg"
        ? bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
        : contentType === "image/gif"
          ? bytes.byteLength >= 6 &&
            ["GIF87a", "GIF89a"].includes(decoder.decode(bytes.subarray(0, 6)))
          : contentType === "image/webp"
            ? bytes.byteLength >= 12 &&
              decoder.decode(bytes.subarray(0, 4)) === "RIFF" &&
              decoder.decode(bytes.subarray(8, 12)) === "WEBP"
            : contentType === "application/pdf"
              ? bytes.byteLength >= 5 && decoder.decode(bytes.subarray(0, 5)) === "%PDF-"
              : false;
  if (!valid) invalidBundle(`${fileName} does not match its file extension.`);
}

function validateHtml(html: string) {
  if (
    /<(?:script|iframe|object|embed|form|input|svg|picture|source|video|audio|base)\b/iu.test(
      html,
    ) ||
    /\son[a-z]+\s*=/iu.test(html) ||
    /(?:href|src)\s*=\s*["']?\s*(?:javascript|data\s*:\s*text\/html)/iu.test(html)
  ) {
    invalidBundle("The template HTML contains executable or unsafe content.");
  }
}

function validateImageReferences(html: string, assets: ImportedEmailTemplateAsset[]) {
  const inlineAssets = new Set(
    assets.filter((asset) => asset.disposition === "inline").map((asset) => asset.fileName),
  );
  const imageTags = html.match(/<img\b[^>]*>/giu) ?? [];
  if ((html.match(/<img\b/giu) ?? []).length !== imageTags.length) {
    invalidBundle("The template HTML contains a malformed image element.");
  }
  for (const tag of imageTags) {
    if (/\bsrcset\s*=/iu.test(tag)) {
      invalidBundle("Template images must use one bundled source without srcset.");
    }
    const sources = [...tag.matchAll(/\bsrc\s*=\s*(["'])(.*?)\1/giu)];
    if (sources.length !== 1) {
      invalidBundle("Every template image must have exactly one quoted src value.");
    }
    const rawSource = sources[0]?.[2]?.trim() ?? "";
    const source = (rawSource.startsWith("cid:") ? rawSource.slice(4) : rawSource).replace(
      /^\.\//u,
      "",
    );
    if (!source || !inlineAssets.has(source)) {
      invalidBundle(`Template image ${rawSource || "(empty)"} is not included in the ZIP.`);
    }
  }
}

export async function readEmailTemplateBundle(
  bytes: Uint8Array,
): Promise<ImportedEmailTemplateBundle> {
  if (bytes.byteLength < 22 || bytes.byteLength > participantEmailTemplateZipMaximumBytes) {
    invalidBundle("Choose a valid ZIP file no larger than 3.5 MB.");
  }
  const entries = await extractArchive(bytes);
  const htmlEntries = entries.filter((entry) => ["html", "htm"].includes(extension(entry.path)));
  if (htmlEntries.length !== 1) {
    invalidBundle("The ZIP must contain exactly one HTML file.");
  }
  const htmlEntry = htmlEntries[0];
  if (!htmlEntry) invalidBundle("The ZIP does not contain an HTML file.");
  if (htmlEntry.bytes.byteLength > maximumEmailTemplateHtmlBytes) {
    invalidBundle("The template HTML must be no larger than 250 KB.");
  }
  const prefixEnd = htmlEntry.path.lastIndexOf("/") + 1;
  const prefix = htmlEntry.path.slice(0, prefixEnd);
  if (prefix && entries.some((entry) => !entry.path.startsWith(prefix))) {
    invalidBundle("All template files must be inside the same folder as the HTML file.");
  }
  let totalAssetBytes = 0;
  const assets = entries
    .filter((entry) => entry !== htmlEntry)
    .map((entry): ImportedEmailTemplateAsset => {
      const fileName = entry.path.slice(prefix.length);
      const contentType = contentTypes[extension(fileName)];
      if (!contentType) {
        invalidBundle(
          `Unsupported asset ${fileName}. Use PNG, JPEG, GIF, WebP, or PDF files.`,
        );
      }
      totalAssetBytes += entry.bytes.byteLength;
      validateAssetBytes(fileName, entry.bytes, contentType);
      const digest = bytesToHex(sha256(entry.bytes));
      return {
        fileName,
        contentType,
        contentId: `${digest.slice(0, 24)}@code2create`,
        disposition: contentType.startsWith("image/") ? "inline" : "attachment",
        bytes: entry.bytes,
      };
    });
  if (totalAssetBytes > maximumEmailTemplateAssetBytes) {
    invalidBundle("The uncompressed email assets must total no more than 3.2 MB.");
  }
  const html = decodeHtml(htmlEntry.bytes);
  validateHtml(html);
  validateImageReferences(html, assets);
  return { html, htmlFileName: htmlEntry.path.slice(prefix.length), assets };
}

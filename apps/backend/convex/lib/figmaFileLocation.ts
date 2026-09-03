import { ConvexError } from "convex/values";

export type FigmaFileLocation = {
  fileKey: string;
  url: string;
};

export function parseFigmaFileLocation(value: string): FigmaFileLocation {
  if (value.length > 2_048) {
    throw new ConvexError({
      code: "FIGMA_URL_INVALID",
      message: "Enter a Figma design or FigJam file link.",
    });
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new ConvexError({
      code: "FIGMA_URL_INVALID",
      message: "Enter a Figma design or FigJam file link.",
    });
  }
  if (
    url.protocol !== "https:" ||
    !["figma.com", "www.figma.com"].includes(url.hostname) ||
    url.port ||
    url.username ||
    url.password
  ) {
    throw new ConvexError({
      code: "FIGMA_URL_INVALID",
      message: "Enter a link from figma.com.",
    });
  }
  const segments = url.pathname.split("/").filter(Boolean);
  const fileType = segments[0];
  const encodedFileKey = segments[1];
  if (!fileType || !["design", "file", "board"].includes(fileType) || !encodedFileKey) {
    throw new ConvexError({
      code: "FIGMA_URL_INVALID",
      message: "Enter a Figma design or FigJam file link.",
    });
  }
  let fileKey: string;
  try {
    fileKey = decodeURIComponent(encodedFileKey);
  } catch {
    throw new ConvexError({
      code: "FIGMA_URL_INVALID",
      message: "The Figma file key is invalid.",
    });
  }
  if (!/^[A-Za-z0-9_-]{6,256}$/.test(fileKey)) {
    throw new ConvexError({
      code: "FIGMA_URL_INVALID",
      message: "The Figma file key is invalid.",
    });
  }
  url.search = "";
  url.hash = "";
  return { fileKey, url: url.toString() };
}

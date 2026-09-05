import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import type { ReviewQuestionPayload } from "./reviewQuestionProtocol.ts";

const models = openaiProvider().getModels();

export async function validReviewQuestionImages(input: ReviewQuestionPayload) {
  const sources = input.sources.filter((source) => source.image);
  if (!sources.length) return input.images.length === 0;
  if (
    input.stage !== "inspect" ||
    sources.length !== 1 ||
    input.images.length !== 1 ||
    !models
      .find((model) => `openai/${model.id}` === input.model)
      ?.input.includes("image")
  )
    return false;
  const source = sources[0];
  const image = input.images[0];
  if (
    !source ||
    !image ||
    source.kind !== "figma" ||
    source.coverage !== "captured" ||
    source.id !== image.sourceId ||
    source.image?.sha256 !== image.sha256
  )
    return false;
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = Uint8Array.from(atob(image.data), (character) =>
      character.charCodeAt(0),
    );
  } catch {
    return false;
  }
  if (
    bytes.length > 8 * 1024 * 1024 ||
    ![137, 80, 78, 71, 13, 10, 26, 10].every(
      (value, index) => bytes[index] === value,
    )
  )
    return false;
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  const digest = Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return digest === image.sha256;
}

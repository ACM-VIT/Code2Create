import { ConvexError } from "convex/values";

import { containsSensitiveProjectText } from "./projectText";
import { fingerprintText, normalizedLongText, normalizedText } from "./strings";

export const noveltyEmbeddingModel = "text-embedding-3-small" as const;
export const noveltyEmbeddingDimensions = 1_536;
export const minimumNoveltyCorpusEntries = 5;
export const maximumNoveltyCorpusEntries = 200;

const discouragedReflectionTerms = [
  "admission",
  "bad idea",
  "decline",
  "judge",
  "judging",
  "reject",
  "score",
  "unoriginal",
  "winner",
] as const;

export type NoveltyBand = "familiar" | "developing" | "distinct";

export type NoveltyPolicy = {
  label: string;
  minimumIdeaLength: number;
  debounceMs: number;
  maximumRequestsPerMinute: number;
  distinctSimilarityBoundary: number;
  commonSimilarityBoundary: number;
  embeddingModel: typeof noveltyEmbeddingModel;
  embeddingDimensions: typeof noveltyEmbeddingDimensions;
};

export type NoveltyCorpusEntryInput = {
  sourceKey: string;
  sourceYear: number;
  themeLabel: string;
  summary: string;
  reflectionPrompt: string;
};

export const defaultNoveltyPolicy: NoveltyPolicy = {
  label: "Code2Create past projects",
  minimumIdeaLength: 50,
  debounceMs: 800,
  maximumRequestsPerMinute: 20,
  distinctSimilarityBoundary: 0.56,
  commonSimilarityBoundary: 0.88,
  embeddingModel: noveltyEmbeddingModel,
  embeddingDimensions: noveltyEmbeddingDimensions,
};

function invalidNoveltyPolicy(message: string): never {
  throw new ConvexError({ code: "INVALID_NOVELTY_POLICY", message });
}

function wholeNumber(value: number, label: string, minimum: number, maximum: number) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    invalidNoveltyPolicy(`${label} must be a whole number from ${minimum} through ${maximum}.`);
  }
  return value;
}

function similarity(value: number, label: string) {
  if (!Number.isFinite(value) || value < -1 || value > 1) {
    invalidNoveltyPolicy(`${label} must be a finite cosine similarity from -1 through 1.`);
  }
  return value;
}

export function normalizeNoveltyPolicy(input: NoveltyPolicy): NoveltyPolicy {
  if (input.embeddingModel !== noveltyEmbeddingModel) {
    invalidNoveltyPolicy(`The embedding model must be ${noveltyEmbeddingModel}.`);
  }
  if (input.embeddingDimensions !== noveltyEmbeddingDimensions) {
    invalidNoveltyPolicy(`The embedding dimension must be ${noveltyEmbeddingDimensions}.`);
  }
  const distinctSimilarityBoundary = similarity(
    input.distinctSimilarityBoundary,
    "Distinct-similarity boundary",
  );
  const commonSimilarityBoundary = similarity(
    input.commonSimilarityBoundary,
    "Common-similarity boundary",
  );
  if (commonSimilarityBoundary - distinctSimilarityBoundary < 0.1) {
    invalidNoveltyPolicy(
      "The common-similarity boundary must be at least 0.1 above the distinct boundary.",
    );
  }
  return {
    label: normalizedText(input.label, "Novelty corpus label", 3, 80),
    minimumIdeaLength: wholeNumber(input.minimumIdeaLength, "Minimum idea length", 30, 200),
    debounceMs: wholeNumber(input.debounceMs, "Typing debounce", 400, 2_000),
    maximumRequestsPerMinute: wholeNumber(
      input.maximumRequestsPerMinute,
      "Maximum checks per minute",
      5,
      60,
    ),
    distinctSimilarityBoundary,
    commonSimilarityBoundary,
    embeddingModel: noveltyEmbeddingModel,
    embeddingDimensions: noveltyEmbeddingDimensions,
  };
}

export function normalizeNoveltyCorpusEntries(
  entries: readonly NoveltyCorpusEntryInput[],
  maximumSourceYear: number,
): NoveltyCorpusEntryInput[] {
  const latestSourceYear = wholeNumber(
    maximumSourceYear,
    "Latest corpus source year",
    2000,
    2100,
  );
  if (
    entries.length < minimumNoveltyCorpusEntries ||
    entries.length > maximumNoveltyCorpusEntries
  ) {
    invalidNoveltyPolicy(
      `A novelty corpus must contain ${minimumNoveltyCorpusEntries} through ${maximumNoveltyCorpusEntries} curated entries.`,
    );
  }
  const normalized = entries.map((entry, index) => {
    const sourceKey = entry.sourceKey.trim().toLowerCase();
    if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u.test(sourceKey) || sourceKey.length > 80) {
      invalidNoveltyPolicy(
        `Corpus entry ${index + 1} needs a lowercase source key using letters, numbers, dots, dashes, or underscores.`,
      );
    }
    const sourceYear = wholeNumber(
      entry.sourceYear,
      `Corpus entry ${index + 1} year`,
      2000,
      latestSourceYear,
    );
    const themeLabel = normalizedText(
      entry.themeLabel,
      `Corpus entry ${index + 1} theme`,
      3,
      80,
    );
    const summary = normalizedLongText(
      entry.summary,
      `Corpus entry ${index + 1} summary`,
      20,
      800,
    );
    const reflectionPrompt = normalizedText(
      entry.reflectionPrompt,
      `Corpus entry ${index + 1} reflection prompt`,
      10,
      180,
    );
    if (containsSensitiveProjectText(`${themeLabel}\n${summary}\n${reflectionPrompt}`)) {
      invalidNoveltyPolicy(
        `Corpus entry ${index + 1} contains contact details, identifiers, or credentials.`,
      );
    }
    if (
      !reflectionPrompt.endsWith("?") ||
      [...reflectionPrompt].filter((character) => character === "?").length !== 1
    ) {
      invalidNoveltyPolicy(`Corpus entry ${index + 1} reflection prompt must be one question.`);
    }
    const lowerPrompt = reflectionPrompt.toLocaleLowerCase("en");
    if (discouragedReflectionTerms.some((term) => lowerPrompt.includes(term))) {
      invalidNoveltyPolicy(
        `Corpus entry ${index + 1} reflection prompt contains discouraging or decision-related wording.`,
      );
    }
    return { sourceKey, sourceYear, themeLabel, summary, reflectionPrompt };
  });
  if (new Set(normalized.map((entry) => entry.sourceKey)).size !== normalized.length) {
    invalidNoveltyPolicy("Novelty corpus source keys must be unique.");
  }
  return normalized.toSorted((left, right) => left.sourceKey.localeCompare(right.sourceKey));
}

export function noveltyCorpusChecksum(
  policy: NoveltyPolicy,
  entries: readonly NoveltyCorpusEntryInput[],
) {
  return fingerprintText(JSON.stringify({ policy, entries }));
}

export function normalizeNoveltyIdea(value: string, minimum: number, maximum: number) {
  return normalizedLongText(value, "Project idea", minimum, maximum);
}

export function noveltyInputFingerprint(value: string) {
  return fingerprintText(value);
}

export function noveltyScoreForSimilarity(
  nearestSimilarity: number,
  policy: Pick<NoveltyPolicy, "distinctSimilarityBoundary" | "commonSimilarityBoundary">,
) {
  if (!Number.isFinite(nearestSimilarity)) {
    throw new Error("Novelty similarity must be finite.");
  }
  const boundedSimilarity = Math.max(-1, Math.min(1, nearestSimilarity));
  if (boundedSimilarity <= policy.distinctSimilarityBoundary) return 100;
  if (boundedSimilarity >= policy.commonSimilarityBoundary) return 0;
  const span = policy.commonSimilarityBoundary - policy.distinctSimilarityBoundary;
  return Math.round(
    ((policy.commonSimilarityBoundary - boundedSimilarity) / span) * 100,
  );
}

export function noveltyBandForScore(score: number): NoveltyBand {
  if (!Number.isSafeInteger(score) || score < 0 || score > 100) {
    throw new Error("Novelty score must be a whole number from 0 through 100.");
  }
  if (score <= 34) return "familiar";
  if (score <= 69) return "developing";
  return "distinct";
}

export function validEmbedding(embedding: readonly number[]) {
  return (
    embedding.length === noveltyEmbeddingDimensions &&
    embedding.every((component) => Number.isFinite(component))
  );
}

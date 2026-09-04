import { ConvexError } from "convex/values";

import { containsSensitiveProjectText } from "./projectText";
import { fingerprintText, normalizedLongText, normalizedText } from "./strings";

export const noveltyEmbeddingModel = "text-embedding-3-small" as const;
export const noveltyEmbeddingDimensions = 1_536;
export const minimumNoveltyCorpusEntries = 5;
export const maximumNoveltyCorpusEntries = 300;
export const noveltyDensityMatchLimit = 50;
export const noveltyEmbeddingSimilarityScale = 1.35;
export const noveltyEmbeddingScoringVersion = "novelty-embedding-v1" as const;
export const noveltyScoringVersion = "novelty-hybrid-v2" as const;
export const noveltyJudgeCandidateLimit = 8;
export const noveltyDensitySimilarityPolicy = {
  distinctSimilarityBoundary: 0.6,
  commonSimilarityBoundary: 0.9,
} as const;

export type NoveltyIdeaLifecycle = "editing" | "saved" | "submitted";

export function noveltyIdeaComparisonScope(
  eventId: string,
  lifecycle: NoveltyIdeaLifecycle,
) {
  return `${eventId}:lifecycle:${lifecycle}`;
}

export function activeAdmissionIdeaComparisonScope(eventId: string) {
  return `${eventId}:active-admission`;
}
export type NoveltyRelationship = "same_core_idea" | "strong_overlap" | "adjacent" | "different";
export type NoveltyJudgeConfidence = "high" | "medium" | "low";

export type NoveltyScoringVersion =
  | typeof noveltyEmbeddingScoringVersion
  | typeof noveltyScoringVersion;

export type CalibratedNoveltyMatch<Metadata> = {
  metadata: Metadata;
  rawSimilarity: number;
  weight: number;
  semanticOverlap: number;
};

export type NoveltyDensityMatch = {
  similarity: number;
  lifecycle: NoveltyIdeaLifecycle;
};

export type TeamNoveltyDensityMatch<TeamId> = NoveltyDensityMatch & {
  teamId: TeamId;
};

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
  ...noveltyDensitySimilarityPolicy,
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
  if (
    distinctSimilarityBoundary !== noveltyDensitySimilarityPolicy.distinctSimilarityBoundary ||
    commonSimilarityBoundary !== noveltyDensitySimilarityPolicy.commonSimilarityBoundary
  ) {
    invalidNoveltyPolicy("Similarity density must start at 0.60 and reach full weight at 0.90.");
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
  const latestSourceYear = wholeNumber(maximumSourceYear, "Latest corpus source year", 2000, 2100);
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
    const themeLabel = normalizedText(entry.themeLabel, `Corpus entry ${index + 1} theme`, 3, 80);
    const summary = normalizedLongText(entry.summary, `Corpus entry ${index + 1} summary`, 20, 800);
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
  // This identifies the content, not the scoring implementation. Keeping the
  // two identities separate lets an existing score remain visible while a new
  // scorer evaluates the same saved revision.
  return fingerprintText(value);
}

export function isCurrentNoveltyScoringVersion(
  value: string | undefined,
): value is NoveltyScoringVersion {
  return value === noveltyEmbeddingScoringVersion || value === noveltyScoringVersion;
}

export function noveltySimilarityWeight(
  matchSimilarity: number,
  policy: Pick<NoveltyPolicy, "distinctSimilarityBoundary" | "commonSimilarityBoundary">,
) {
  if (!Number.isFinite(matchSimilarity)) {
    throw new Error("Novelty similarity must be finite.");
  }
  const boundedSimilarity = Math.max(-1, Math.min(1, matchSimilarity));
  if (boundedSimilarity <= policy.distinctSimilarityBoundary) return 0;
  if (boundedSimilarity >= policy.commonSimilarityBoundary) return 1;
  const span = policy.commonSimilarityBoundary - policy.distinctSimilarityBoundary;
  return (boundedSimilarity - policy.distinctSimilarityBoundary) / span;
}

export function noveltyDensitySimilarity(matchSimilarity: number) {
  if (!Number.isFinite(matchSimilarity)) {
    throw new Error("Novelty similarity must be finite.");
  }
  return Math.max(-1, Math.min(1, matchSimilarity * noveltyEmbeddingSimilarityScale));
}

export function noveltyLifecycleWeight(lifecycle: NoveltyIdeaLifecycle) {
  if (lifecycle === "editing") return 0.5;
  if (lifecycle === "saved") return 0.8;
  return 1;
}

export function noveltyRelationshipWeight(relationship: NoveltyRelationship) {
  if (relationship === "same_core_idea") return 1;
  if (relationship === "strong_overlap") return 0.72;
  if (relationship === "adjacent") return 0.25;
  return 0;
}

export function hybridNoveltyWeight(
  embeddingWeight: number,
  rawSimilarity: number,
  relationship: NoveltyRelationship,
  confidence: NoveltyJudgeConfidence,
) {
  if (!Number.isFinite(embeddingWeight)) {
    throw new Error("Embedding novelty weight must be finite.");
  }
  if (!Number.isFinite(rawSimilarity)) {
    throw new Error("Raw novelty similarity must be finite.");
  }
  const boundedEmbeddingWeight = Math.max(0, Math.min(1, embeddingWeight));
  const boundedRawSimilarity = Math.max(-1, Math.min(1, rawSimilarity));
  const calibratedRelationship =
    boundedRawSimilarity < 0.4
      ? "different"
      : boundedRawSimilarity < 0.54 &&
          (relationship === "same_core_idea" || relationship === "strong_overlap")
        ? "adjacent"
        : boundedRawSimilarity < 0.6 && relationship === "same_core_idea"
          ? "strong_overlap"
          : relationship;
  const judgeWeight = noveltyRelationshipWeight(calibratedRelationship);
  const judgeInfluence = confidence === "high" ? 0.65 : confidence === "medium" ? 0.4 : 0.2;
  const blended = boundedEmbeddingWeight + judgeInfluence * (judgeWeight - boundedEmbeddingWeight);
  if (confidence === "high" && calibratedRelationship === "same_core_idea") {
    return Math.max(0.95, blended);
  }
  if (confidence === "high" && calibratedRelationship === "strong_overlap") {
    return Math.max(0.72, blended);
  }
  if (confidence === "high" && calibratedRelationship === "different") {
    return Math.min(0.15, blended);
  }
  return Math.max(0, Math.min(1, blended));
}

/**
 * Cosine values need a stricter bar for a closest-match penalty than they do
 * for aggregate density. This prevents a single broad-domain match from
 * looking like an exact duplicate while still catching close paraphrases.
 */
export function semanticOverlapFromEmbedding(matchSimilarity: number) {
  if (!Number.isFinite(matchSimilarity)) {
    throw new Error("Novelty similarity must be finite.");
  }
  const lowerBoundary = 0.54;
  const upperBoundary = 0.78;
  return Math.max(
    0,
    Math.min(1, (matchSimilarity - lowerBoundary) / (upperBoundary - lowerBoundary)),
  );
}

export function calibratedNoveltyMatch<Metadata>(args: {
  metadata: Metadata;
  rawSimilarity: number;
  relationship?: NoveltyRelationship;
  confidence?: NoveltyJudgeConfidence;
}): CalibratedNoveltyMatch<Metadata> {
  const embeddingWeight = noveltySimilarityWeight(
    noveltyDensitySimilarity(args.rawSimilarity),
    noveltyDensitySimilarityPolicy,
  );
  const embeddingOverlap = semanticOverlapFromEmbedding(args.rawSimilarity);
  if (args.relationship === undefined || args.confidence === undefined) {
    return {
      metadata: args.metadata,
      rawSimilarity: args.rawSimilarity,
      weight: embeddingWeight,
      semanticOverlap: embeddingOverlap,
    };
  }
  return {
    metadata: args.metadata,
    rawSimilarity: args.rawSimilarity,
    weight: hybridNoveltyWeight(
      embeddingWeight,
      args.rawSimilarity,
      args.relationship,
      args.confidence,
    ),
    semanticOverlap: hybridNoveltyWeight(
      embeddingOverlap,
      args.rawSimilarity,
      args.relationship,
      args.confidence,
    ),
  };
}

export function strongestCalibratedNoveltyMatch<Metadata>(
  matches: readonly CalibratedNoveltyMatch<Metadata>[],
) {
  return matches.reduce<CalibratedNoveltyMatch<Metadata> | null>((strongest, match) => {
    if (!strongest) return match;
    if (match.weight !== strongest.weight) {
      return match.weight > strongest.weight ? match : strongest;
    }
    if (match.semanticOverlap !== strongest.semanticOverlap) {
      return match.semanticOverlap > strongest.semanticOverlap ? match : strongest;
    }
    return match.rawSimilarity > strongest.rawSimilarity ? match : strongest;
  }, null);
}

export function effectiveSimilarTeams(
  matches: readonly NoveltyDensityMatch[],
  policy: Pick<NoveltyPolicy, "distinctSimilarityBoundary" | "commonSimilarityBoundary">,
) {
  return matches.reduce(
    (total, match) =>
      total +
      noveltySimilarityWeight(match.similarity, policy) * noveltyLifecycleWeight(match.lifecycle),
    0,
  );
}

export function strongestNoveltyMatchPerTeam<TeamId, Match extends TeamNoveltyDensityMatch<TeamId>>(
  matches: readonly Match[],
  excludedTeamId?: TeamId,
) {
  const strongest = new Map<TeamId, Match>();
  for (const match of matches) {
    if (match.teamId === excludedTeamId) continue;
    const current = strongest.get(match.teamId);
    if (
      !current ||
      noveltyLifecycleWeight(match.lifecycle) > noveltyLifecycleWeight(current.lifecycle) ||
      (noveltyLifecycleWeight(match.lifecycle) === noveltyLifecycleWeight(current.lifecycle) &&
        match.similarity > current.similarity)
    ) {
      strongest.set(match.teamId, match);
    }
  }
  return strongest;
}

export function noveltyScoreForDensity(similarTeams: number) {
  if (!Number.isFinite(similarTeams) || similarTeams < 0) {
    throw new Error("Effective similar teams must be a non-negative finite number.");
  }
  const score = 100 * (1 - Math.log1p(similarTeams) / Math.log(21));
  return Math.round(Math.max(0, Math.min(100, score)));
}

export function noveltyScoreForEvidence(similarTeams: number, strongestOverlap: number) {
  if (!Number.isFinite(strongestOverlap) || strongestOverlap < 0) {
    throw new Error("Strongest novelty overlap must be a non-negative finite number.");
  }
  const boundedOverlap = Math.min(1, strongestOverlap);
  const closestMatchScore = Math.round(100 * (1 - boundedOverlap ** 1.25));
  return Math.min(noveltyScoreForDensity(similarTeams), closestMatchScore);
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

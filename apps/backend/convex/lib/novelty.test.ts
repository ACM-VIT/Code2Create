import { describe, expect, it } from "vitest";

import {
  effectiveSimilarTeams,
  noveltyEmbeddingDimensions,
  noveltyScoreForDensity,
  strongestNoveltyMatchPerTeam,
  validEmbedding,
} from "./novelty";
import { containsSensitiveProjectText } from "./projectText";

const stopWords = new Set([
  "a", "and", "from", "in", "is", "of", "on", "or", "that", "the", "their", "through", "to", "with",
]);

function featureHash(value: string) {
  let hash = 2_166_136_261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function testEmbedding(value: string) {
  const tokens = (value.normalize("NFKC").toLocaleLowerCase("en").match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((token) => !stopWords.has(token));
  const features = [
    ...tokens.map((token) => ({ value: `word:${token}`, weight: 1 })),
    ...tokens.slice(1).map((token, index) => ({
      value: `pair:${tokens[index]}:${token}`,
      weight: 0.5,
    })),
  ];
  const components = new Map<number, number>();
  for (const feature of features) {
    const hash = featureHash(feature.value);
    const index = hash % noveltyEmbeddingDimensions;
    const sign = (hash & 0x8000_0000) === 0 ? 1 : -1;
    components.set(index, (components.get(index) ?? 0) + feature.weight * sign);
  }
  const embedding = Array.from(
    { length: noveltyEmbeddingDimensions },
    (_, index) => components.get(index) ?? 0,
  );
  const magnitude = Math.sqrt(
    embedding.reduce((sum, component) => sum + component * component, 0),
  );
  if (magnitude === 0) throw new Error("The test text produced no vector.");
  return embedding.map((component) => component / magnitude);
}

function cosine(left: readonly number[], right: readonly number[]) {
  return left.reduce((sum, component, index) => sum + component * (right[index] ?? 0), 0);
}

describe("novelty scoring", () => {
  it("does not mistake regression tests for a registration number", () => {
    expect(containsSensitiveProjectText(
      "The project generates a verified fix with regression tests before deployment.",
    )).toBe(false);
    expect(containsSensitiveProjectText(
      "Use registration number 23BCE1234 to open the project.",
    )).toBe(true);
  });

  it("is deterministic and uses the production vector width", () => {
    const first = testEmbedding("A pothole report that routes repair work to ward teams");
    const second = testEmbedding("A pothole report that routes repair work to ward teams");

    expect(first).toHaveLength(noveltyEmbeddingDimensions);
    expect(validEmbedding(first)).toBe(true);
    expect(second).toEqual(first);
  });

  it("keeps related fixture text closer than unrelated text", () => {
    const idea = testEmbedding("Report potholes and follow the municipal repair workflow");
    const related = testEmbedding("Pothole reporting with repair status from municipal teams");
    const unrelated = testEmbedding("Practice spoken language through peer roleplay lessons");

    expect(cosine(idea, related)).toBeGreaterThan(cosine(idea, unrelated));
  });

  it("penalizes the density of close team ideas instead of only the nearest one", () => {
    const density = effectiveSimilarTeams(
      Array.from({ length: 10 }, () => ({ similarity: 0.95, lifecycle: "submitted" } as const)),
      {
        distinctSimilarityBoundary: 0.6,
        commonSimilarityBoundary: 0.9,
      },
    );
    expect(noveltyScoreForDensity(density)).toBeLessThanOrEqual(21);
  });

  it("counts hundreds of teams once when retrieval returns repeated candidates", () => {
    const candidates = Array.from({ length: 350 }, (_, teamIndex) =>
      Array.from({ length: 3 }, (_, candidateIndex) => ({
        teamId: `team-${teamIndex}`,
        similarity: candidateIndex === 0 ? 0.95 : 0.7 + candidateIndex * 0.05,
        lifecycle: candidateIndex === 0 ? "editing" as const : "saved" as const,
      }))
    ).flat();

    const strongest = strongestNoveltyMatchPerTeam(candidates);

    expect(strongest.size).toBe(350);
    expect(strongest.get("team-0")?.similarity).toBeCloseTo(0.8);
    expect(strongest.get("team-0")?.lifecycle).toBe("saved");
  });

  it("keeps the signal informative across practical crowd sizes", () => {
    const scenarios = [
      { similarTeams: 0, expectedScore: 100 },
      { similarTeams: 2, expectedScore: 64 },
      { similarTeams: 10, expectedScore: 21 },
      { similarTeams: 50, expectedScore: 0 },
    ] as const;

    for (const scenario of scenarios) {
      expect(noveltyScoreForDensity(scenario.similarTeams)).toBe(scenario.expectedScore);
    }
  });
});

import { describe, expect, it } from "vitest";

import {
  noveltyEmbeddingDimensions,
  noveltyScoreForSimilarity,
  validEmbedding,
} from "./novelty";

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

  it("does not present a close local-corpus match as fully novel", () => {
    const idea = testEmbedding(
      "A road damage reporting tool that follows each pothole from a resident photo through municipal routing, repair assignment, and proof that the road was fixed.",
    );
    const priorProject = testEmbedding(
      "Residents photograph road damage, route it to a municipal team, and follow repair progress.",
    );
    const similarity = cosine(idea, priorProject);

    expect(noveltyScoreForSimilarity(similarity, {
      distinctSimilarityBoundary: 0.08,
      commonSimilarityBoundary: 0.34,
    })).toBeLessThanOrEqual(34);
  });
});

import { describe, expect, it } from "vitest";

import {
  localNoveltyEmbedding,
  noveltyEmbeddingDimensions,
  noveltyScoreForSimilarity,
  validEmbedding,
} from "./novelty";

function cosine(left: readonly number[], right: readonly number[]) {
  return left.reduce((sum, component, index) => sum + component * (right[index] ?? 0), 0);
}

describe("local novelty embedding", () => {
  it("is deterministic and uses the production vector width", () => {
    const first = localNoveltyEmbedding("A pothole report that routes repair work to ward teams");
    const second = localNoveltyEmbedding("A pothole report that routes repair work to ward teams");

    expect(first).toHaveLength(noveltyEmbeddingDimensions);
    expect(validEmbedding(first)).toBe(true);
    expect(second).toEqual(first);
  });

  it("keeps related fixture text closer than unrelated text", () => {
    const idea = localNoveltyEmbedding("Report potholes and follow the municipal repair workflow");
    const related = localNoveltyEmbedding("Pothole reporting with repair status from municipal teams");
    const unrelated = localNoveltyEmbedding("Practice spoken language through peer roleplay lessons");

    expect(cosine(idea, related)).toBeGreaterThan(cosine(idea, unrelated));
  });

  it("does not present a close local-corpus match as fully novel", () => {
    const idea = localNoveltyEmbedding(
      "A road damage reporting tool that follows each pothole from a resident photo through municipal routing, repair assignment, and proof that the road was fixed.",
    );
    const priorProject = localNoveltyEmbedding(
      "Residents photograph road damage, route it to a municipal team, and follow repair progress.",
    );
    const similarity = cosine(idea, priorProject);

    expect(noveltyScoreForSimilarity(similarity, {
      distinctSimilarityBoundary: 0.08,
      commonSimilarityBoundary: 0.34,
    })).toBeLessThanOrEqual(34);
  });
});

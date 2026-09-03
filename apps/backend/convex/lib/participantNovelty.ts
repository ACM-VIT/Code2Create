import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { isCurrentNoveltyScoringVersion, noveltyInputFingerprint } from "./novelty";

type ReadCtx = QueryCtx | MutationCtx;

export async function participantNoveltyConfig(
  ctx: ReadCtx,
  event: Doc<"events">,
  draft?: Doc<"projectDrafts">,
) {
  const corpusVersionId = draft?.noveltyCorpusVersionId ?? event.publishedNoveltyCorpusVersionId;
  if (!corpusVersionId) return null;
  const corpus = await ctx.db.get(corpusVersionId);
  const validStatus = draft?.noveltyCorpusVersionId
    ? corpus?.status === "published" || corpus?.status === "superseded"
    : corpus?.status === "published";
  if (
    !corpus ||
    corpus.eventId !== event._id ||
    !validStatus ||
    corpus.importState !== "ready" ||
    !corpus.checksum ||
    corpus.entryCount < 1
  ) {
    return null;
  }
  return {
    corpusVersionId: corpus._id,
    corpusVersion: corpus.version,
    corpusLabel: corpus.label,
    comparedProjectCount: corpus.entryCount,
    minimumIdeaLength: corpus.minimumIdeaLength,
    debounceMs: corpus.debounceMs,
  };
}

export function savedNoveltySignal(
  draft: Doc<"projectDrafts">,
  idea: string,
  corpusVersionId?: Id<"noveltyCorpusVersions">,
) {
  if (
    (corpusVersionId !== undefined && draft.noveltyCorpusVersionId !== corpusVersionId) ||
    draft.noveltyEvaluatedInputFingerprint !== noveltyInputFingerprint(idea) ||
    draft.noveltyScore === undefined ||
    draft.noveltyBand === undefined ||
    draft.noveltyNearestThemeLabel === undefined ||
    draft.noveltyReflectionPrompt === undefined ||
    draft.noveltyEvaluatedAt === undefined ||
    !isCurrentNoveltyScoringVersion(draft.noveltyScoringVersion)
  ) {
    return null;
  }
  return {
    score: draft.noveltyScore,
    band: draft.noveltyBand,
    nearestThemeLabel: draft.noveltyNearestThemeLabel,
    reflectionPrompt: draft.noveltyReflectionPrompt,
    evaluatedAt: draft.noveltyEvaluatedAt,
  };
}

export function completedNoveltyPreviewSignal(
  request: Doc<"noveltyPreviewRequests"> | null,
  corpusVersionId: Id<"noveltyCorpusVersions">,
) {
  if (
    request === null ||
    request.corpusVersionId !== corpusVersionId ||
    request.state !== "succeeded" ||
    request.score === undefined ||
    request.band === undefined ||
    request.nearestThemeLabel === undefined ||
    request.reflectionPrompt === undefined ||
    request.completedAt === undefined ||
    !isCurrentNoveltyScoringVersion(request.scoringVersion)
  ) {
    return null;
  }
  return {
    score: request.score,
    band: request.band,
    nearestThemeLabel: request.nearestThemeLabel,
    reflectionPrompt: request.reflectionPrompt,
    evaluatedAt: request.completedAt,
  };
}

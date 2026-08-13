import type { OperationsAutonomyRecommendationCitation } from "./intelligenceRecommendations.ts";
import type { OperationsAutonomyRunIdentity } from "./operationsAutonomyProtocol.ts";

/** Recommendation support is a separately signed, append-only evidence stream. */
export const operationsAutonomyRecommendationEvidenceSignatureContext =
  "code2create.operations-autonomy.recommendation-evidence.v1";

export const operationsAutonomyRecommendationEvidenceChunkMaximumCitations = 4;

export type OperationsAutonomyRecommendationEvidenceSeal = {
  evidenceSetId: string;
  rootHash: string;
  leafCount: number;
  chunkCount: number;
  sealedSequence: number;
};

export type OperationsAutonomyRecommendationEvidenceChunkRequest =
  OperationsAutonomyRunIdentity & {
    proposalKey: string;
    evidenceSetId: string;
    pageIndex: number;
    /** Absent only for page zero. */
    previousPageHash?: string;
    citations: OperationsAutonomyRecommendationCitation[];
    /** The terminal chunk atomically seals the complete evidence set. */
    isDone: boolean;
  };

export type OperationsAutonomyRecommendationEvidenceChunkReceipt = {
  state: "accepted";
  sequence: number;
  evidenceSetId: string;
  pageIndex: number;
  pageHash: string;
  isDone: boolean;
  seal?: OperationsAutonomyRecommendationEvidenceSeal;
};

export type OperationsAutonomyRecommendationEvidenceLeaf = {
  ordinal: number;
  identity: string;
  citation: OperationsAutonomyRecommendationCitation;
};

/** Canonical SHA-256 input shared by Worker and Convex for one leaf identity. */
export function operationsAutonomyRecommendationEvidenceLeafIdentityParts(
  citation: OperationsAutonomyRecommendationCitation,
) {
  return [
    "operations-autonomy-recommendation-evidence-leaf-v1",
    citation.operationId,
    citation.snapshot,
    citation.read,
    citation.generatedAt,
    JSON.stringify(citation.keys),
  ] as const;
}

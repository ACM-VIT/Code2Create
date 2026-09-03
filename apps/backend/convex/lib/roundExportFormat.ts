import type { PaginationOptions } from "convex/server";

import type { Doc } from "../_generated/dataModel";

const exportPageSize = 8;

export type RoundExportCsvRecord = {
  roundReference: string;
  roundName: string;
  teamReference: string;
  teamName: string;
  teamState: string;
  applicationState: string;
  reviewReference: string;
  reviewState: string;
  panelReference: string;
  panelName: string;
  reviewerReference: string;
  reviewerName: string;
  scorecardReference: string;
  scorecardVersionReference: string;
  scorecardVersion: string;
  submissionSource: string;
  submittedAt: string;
  criterionKey: string;
  criterionLabel: string;
  criterionWeight: string;
  rating: string;
  evidenceNote: string;
  privateNote: string;
  evaluationScoreCount: string;
  evaluationMean: string;
  evaluationWeightedPoints: string;
  spreadFlag: string;
  totalPoints: string;
  sharedFindings: string;
  sharedCommitments: string;
  disposition: string;
};

export const roundExportCsvHeader = [
  "Round reference",
  "Round name",
  "Team reference",
  "Team name",
  "Team state",
  "Application state",
  "Review reference",
  "Review state",
  "Panel reference",
  "Panel name",
  "Reviewer reference",
  "Reviewer name",
  "Scorecard reference",
  "Scorecard version reference",
  "Scorecard version",
  "Submission source",
  "Submitted at",
  "Criterion key",
  "Criterion label",
  "Criterion weight",
  "Rating",
  "Evidence note",
  "Private note",
  "Evaluation score count",
  "Evaluation mean",
  "Evaluation weighted points",
  "Spread flag",
  "Total points",
  "Shared findings",
  "Shared commitments",
  "Disposition",
] as const;

export function roundExportCsvRow(record: RoundExportCsvRecord) {
  return [
    record.roundReference,
    record.roundName,
    record.teamReference,
    record.teamName,
    record.teamState,
    record.applicationState,
    record.reviewReference,
    record.reviewState,
    record.panelReference,
    record.panelName,
    record.reviewerReference,
    record.reviewerName,
    record.scorecardReference,
    record.scorecardVersionReference,
    record.scorecardVersion,
    record.submissionSource,
    record.submittedAt,
    record.criterionKey,
    record.criterionLabel,
    record.criterionWeight,
    record.rating,
    record.evidenceNote,
    record.privateNote,
    record.evaluationScoreCount,
    record.evaluationMean,
    record.evaluationWeightedPoints,
    record.spreadFlag,
    record.totalPoints,
    record.sharedFindings,
    record.sharedCommitments,
    record.disposition,
  ];
}

export type RoundExportPageResult = {
  continueCursor: string;
  isDone: boolean;
  jsonEntries: string[];
  csvRows: string[][];
  counts: Doc<"roundExports">["counts"];
};

export function roundExportPageOptions(cursor: string | null): PaginationOptions {
  return { cursor, numItems: exportPageSize };
}

import { operationsAutonomyRecommendationEvidenceLeafIdentityParts } from "@code2create/domain";
import * as v from "valibot";

import {
  autonomyCandidateRecommendationSchema,
  autonomyEvidenceFindingSchema,
} from "./autonomyProtocol.ts";
import type { AutonomyEvidenceDigest } from "./autonomyEvidence.ts";
import type { AutonomyCitation } from "./autonomyExecution.ts";

const digestIdSchema = v.pipe(v.string(), v.regex(/^digest-[a-f0-9]{64}$/u));
const sourceOrdinalSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
export const autonomyEvidenceRecordIdSchema = v.pipe(v.string(), v.regex(/^record-[a-f0-9]{64}$/u));

export const autonomyEvidenceRecordSchema = v.variant("kind", [
  v.strictObject({
    recordId: autonomyEvidenceRecordIdSchema,
    kind: v.literal("finding"),
    scope: v.picklist(["source", "derived"]),
    sourceOrdinal: v.optional(sourceOrdinalSchema),
    sourceDigestId: digestIdSchema,
    supportRecordIds: v.pipe(v.array(autonomyEvidenceRecordIdSchema), v.maxLength(4)),
    finding: autonomyEvidenceFindingSchema,
  }),
  v.strictObject({
    recordId: autonomyEvidenceRecordIdSchema,
    kind: v.literal("candidate"),
    scope: v.picklist(["source", "derived"]),
    sourceOrdinal: v.optional(sourceOrdinalSchema),
    sourceDigestId: digestIdSchema,
    supportRecordIds: v.pipe(v.array(autonomyEvidenceRecordIdSchema), v.maxLength(4)),
    candidate: autonomyCandidateRecommendationSchema,
  }),
]);

export type AutonomyEvidenceRecord = v.InferOutput<typeof autonomyEvidenceRecordSchema>;

export type AutonomyEvidencePair = {
  left: AutonomyEvidenceRecord;
  right: AutonomyEvidenceRecord;
};

export type AutonomyHypothesisRecord = {
  record: AutonomyEvidenceRecord;
};

export type AutonomySupportLeaf = {
  identity: string;
  citation: AutonomyCitation;
};

const encoder = new TextEncoder();

function hexadecimal(bytes: Uint8Array) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function recordId(value: unknown) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(JSON.stringify(value)));
  return `record-${hexadecimal(new Uint8Array(digest))}`;
}

export function canonicalAutonomyCitation(citation: AutonomyCitation): AutonomyCitation {
  return { ...citation, keys: [...citation.keys].sort() };
}

export async function autonomyCitationIdentity(citation: AutonomyCitation) {
  const canonical = canonicalAutonomyCitation(citation);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(
      JSON.stringify(operationsAutonomyRecommendationEvidenceLeafIdentityParts(canonical)),
    ),
  );
  return hexadecimal(new Uint8Array(digest));
}

export async function evidenceRecordsForDigest(
  digest: AutonomyEvidenceDigest,
): Promise<AutonomyEvidenceRecord[]> {
  if (digest.recordScope === "none") return [];
  if (digest.recordScope === "source" && digest.sourceOrdinal === undefined) {
    throw new Error("A source evidence digest requires a durable ordinal.");
  }
  const findings = await Promise.all(
    digest.content.findings.map(async (finding) => ({
      recordId: await recordId([
        "finding",
        digest.digestId,
        finding.supportRecordIds ?? [],
        finding,
      ]),
      kind: "finding" as const,
      scope: digest.recordScope,
      ...(digest.sourceOrdinal === undefined ? {} : { sourceOrdinal: digest.sourceOrdinal }),
      sourceDigestId: digest.digestId,
      supportRecordIds: finding.supportRecordIds ?? [],
      finding,
    })),
  );
  const candidates = await Promise.all(
    digest.candidates.map(async (candidate) => ({
      recordId: await recordId([
        "candidate",
        digest.digestId,
        candidate.supportRecordIds ?? [],
        candidate,
      ]),
      kind: "candidate" as const,
      scope: digest.recordScope,
      ...(digest.sourceOrdinal === undefined ? {} : { sourceOrdinal: digest.sourceOrdinal }),
      sourceDigestId: digest.digestId,
      supportRecordIds: candidate.supportRecordIds ?? [],
      candidate,
    })),
  );
  return [...findings, ...candidates].map((record) =>
    v.parse(autonomyEvidenceRecordSchema, record),
  );
}

export function synthesisPairCursor(pair: AutonomyEvidencePair) {
  return `${pair.left.recordId}.${pair.right.recordId}`;
}

export function parseSynthesisPairCursor(value: string) {
  const match = /^(record-[a-f0-9]{64})\.(record-[a-f0-9]{64})$/u.exec(value);
  if (match === null) return null;
  const left = match[1];
  const right = match[2];
  return left === undefined || right === undefined ? null : { left, right };
}

export function selectSynthesisPairPage(args: {
  left: readonly AutonomyEvidenceRecord[];
  right: readonly AutonomyEvidenceRecord[];
  cursor?: string;
  limit: number;
}) {
  const parsedCursor =
    args.cursor === undefined ? undefined : parseSynthesisPairCursor(args.cursor);
  if (parsedCursor === null) {
    throw new Error("The autonomy synthesis cursor is invalid.");
  }
  const cursor = parsedCursor;
  const pairs: AutonomyEvidencePair[] = [];
  let hasMore = false;
  for (const left of [...args.left].sort((a, b) => a.recordId.localeCompare(b.recordId))) {
    for (const right of [...args.right].sort((a, b) => a.recordId.localeCompare(b.recordId))) {
      if (
        cursor !== undefined &&
        (left.recordId < cursor.left ||
          (left.recordId === cursor.left && right.recordId <= cursor.right))
      )
        continue;
      if (pairs.length === args.limit) {
        hasMore = true;
        break;
      }
      pairs.push({ left, right });
    }
    if (hasMore) break;
  }
  const last = pairs.at(-1);
  return {
    pairs,
    ...(hasMore && last !== undefined ? { cursor: synthesisPairCursor(last) } : {}),
    isDone: !hasMore,
  };
}

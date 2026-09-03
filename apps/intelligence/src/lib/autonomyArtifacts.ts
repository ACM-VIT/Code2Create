import * as v from "valibot";

import {
  autonomyEvidenceDigestSchema,
  autonomyEvidenceTargetSchema,
  type AutonomyEvidenceDigest,
  type AutonomyEvidenceTarget,
} from "./autonomyEvidence.ts";
import type { AutonomyReadReceipt } from "./autonomyExecution.ts";
import {
  autonomyOperationIdSchema,
  operationsAutonomyReadReceiptSchema,
} from "./autonomyProtocol.ts";
import {
  autonomyEvidenceRecordSchema,
  autonomyEvidenceRecordIdSchema,
  evidenceRecordsForDigest,
  selectSynthesisPairPage,
  type AutonomyEvidenceRecord,
  type AutonomyEvidencePair,
  type AutonomyHypothesisRecord,
  type AutonomySupportLeaf,
  autonomyCitationIdentity,
  canonicalAutonomyCitation,
} from "./autonomyCatalog.ts";

export type AutonomyArtifactStore = {
  putDigest(digest: AutonomyEvidenceDigest): Promise<void>;
  getDigest(digestId: string): Promise<AutonomyEvidenceDigest>;
  putTargets(targets: readonly AutonomyEvidenceTarget[]): Promise<void>;
  hasTarget(target: AutonomyEvidenceTarget): Promise<boolean>;
  putReadPage(receipt: AutonomyReadReceipt): Promise<string>;
  getReadPage(artifactId: string): Promise<AutonomyReadReceipt>;
  clearRunArtifacts(): Promise<void>;
  prepareRootCatalog(args: { rootDigestId: string; limit: number }): Promise<{ isDone: boolean }>;
  claimCandidateEffect(effectKey: string, recordId: string): Promise<void>;
  readCandidateEffects(args: { rootDigestId: string; cursor?: string; limit: number }): Promise<{
    effectKeys: string[];
    cursor?: string;
    isDone: boolean;
  }>;
  readCandidateEffectVariants(args: {
    rootDigestId: string;
    effectKey: string;
    cursor?: string;
    limit: number;
  }): Promise<{
    records: Extract<AutonomyEvidenceRecord, { kind: "candidate" }>[];
    cursor?: string;
    isDone: boolean;
  }>;
  claimCursor(args: {
    claimId: string;
    read: string;
    snapshot: string;
    cursor: string;
  }): Promise<boolean>;
  readSynthesisPairs(args: {
    leftDigestId: string;
    rightDigestId: string;
    cursor?: string;
    limit: number;
  }): Promise<{
    pairs: AutonomyEvidencePair[];
    cursor?: string;
    isDone: boolean;
  }>;
  readHypothesisRecords(args: {
    rootDigestIds: string[];
    afterRecordId?: string;
    limit: number;
  }): Promise<{
    records: AutonomyHypothesisRecord[];
    nextRecordId?: string;
    isDone: boolean;
  }>;
  collectSupportLeaves(args: {
    collectionId: string;
    rootRecordId: string;
    limit: number;
  }): Promise<{ isDone: boolean }>;
  readSupportLeaves(args: {
    collectionId: string;
    afterIdentity?: string;
    limit: number;
  }): Promise<{
    leaves: AutonomySupportLeaf[];
    cursor?: string;
    isDone: boolean;
  }>;
  readCandidateRecords(args: { rootDigestId: string; cursor?: string; limit: number }): Promise<{
    records: Extract<AutonomyEvidenceRecord, { kind: "candidate" }>[];
    cursor?: string;
    isDone: boolean;
  }>;
  readFindingRecords(args: { rootDigestId: string; cursor?: string; limit: number }): Promise<{
    records: Extract<AutonomyEvidenceRecord, { kind: "finding" }>[];
    cursor?: string;
    isDone: boolean;
  }>;
  getEvidenceRecord(recordId: string): Promise<AutonomyEvidenceRecord>;
};

const readArtifactSchema = v.strictObject({
  receipt: operationsAutonomyReadReceiptSchema,
  operationId: autonomyOperationIdSchema,
  byteLength: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
});

export function serializeAutonomyReadArtifact(receipt: AutonomyReadReceipt) {
  return v.parse(readArtifactSchema, {
    receipt: {
      state: receipt.state,
      sequence: receipt.sequence,
      read: receipt.read,
      data: receipt.data,
      page: receipt.page,
    },
    operationId: receipt.operationId,
    byteLength: receipt.byteLength,
  });
}

export function parseAutonomyReadArtifact(value: string): AutonomyReadReceipt {
  const parsed = v.parse(readArtifactSchema, JSON.parse(value));
  return {
    ...parsed.receipt,
    operationId: parsed.operationId,
    byteLength: parsed.byteLength,
  };
}

export function serializeAutonomyEvidenceTarget(target: AutonomyEvidenceTarget) {
  return JSON.stringify(target);
}

export function memoryAutonomyArtifactStore(): AutonomyArtifactStore {
  const digests = new Map<string, string>();
  const targets = new Set<string>();
  const cursors = new Map<string, string>();
  const candidateEffects = new Map<string, Set<string>>();
  const records = new Map<string, string>();
  const digestRecords = new Map<string, Set<string>>();
  const supportCollections = new Map<
    string,
    {
      rootRecordId: string;
      frontier: Set<string>;
      seen: Set<string>;
      leaves: Map<string, AutonomySupportLeaf>;
      complete: boolean;
    }
  >();
  const preparedRoots = new Map<string, Set<string>>();

  const descendants = (rootDigestId: string) => {
    const values = new Set<string>();
    const pending = [rootDigestId];
    while (pending.length > 0) {
      const digestId = pending.pop();
      if (digestId === undefined || values.has(digestId)) continue;
      values.add(digestId);
      const value = digests.get(digestId);
      if (value === undefined) continue;
      const digest = v.parse(autonomyEvidenceDigestSchema, JSON.parse(value));
      pending.push(...digest.children);
    }
    return values;
  };
  const recordsForRoot = (rootDigestId: string) => {
    const values: AutonomyEvidenceRecord[] = [];
    for (const digestId of descendants(rootDigestId)) {
      for (const recordId of digestRecords.get(digestId) ?? []) {
        const value = records.get(recordId);
        if (value !== undefined) {
          values.push(v.parse(autonomyEvidenceRecordSchema, JSON.parse(value)));
        }
      }
    }
    return values;
  };
  return {
    async putDigest(digest) {
      const parsed = v.parse(autonomyEvidenceDigestSchema, digest);
      const value = JSON.stringify(parsed);
      const existing = digests.get(digest.digestId);
      if (existing !== undefined && existing !== value) {
        throw new Error("An autonomy evidence artifact id was reused with new content.");
      }
      digests.set(digest.digestId, value);
      const memberIds = digestRecords.get(parsed.digestId) ?? new Set<string>();
      for (const record of await evidenceRecordsForDigest(parsed)) {
        if (
          record.scope === "derived" &&
          record.supportRecordIds.some((recordId) => !records.has(recordId))
        )
          throw new Error("A derived evidence record references unavailable support.");
        const serialized = JSON.stringify(record);
        const existingRecord = records.get(record.recordId);
        if (existingRecord !== undefined && existingRecord !== serialized) {
          throw new Error("An autonomy evidence record id was reused with new content.");
        }
        records.set(record.recordId, serialized);
        memberIds.add(record.recordId);
      }
      digestRecords.set(parsed.digestId, memberIds);
    },
    async getDigest(digestId) {
      const value = digests.get(digestId);
      if (value === undefined) throw new Error("The autonomy evidence artifact is missing.");
      return v.parse(autonomyEvidenceDigestSchema, JSON.parse(value));
    },
    async putTargets(values) {
      for (const target of values) {
        targets.add(serializeAutonomyEvidenceTarget(v.parse(autonomyEvidenceTargetSchema, target)));
      }
    },
    async hasTarget(target) {
      return targets.has(
        serializeAutonomyEvidenceTarget(v.parse(autonomyEvidenceTargetSchema, target)),
      );
    },
    async putReadPage(receipt) {
      const id = `read-${receipt.operationId}`;
      const value = JSON.stringify(serializeAutonomyReadArtifact(receipt));
      const existing = digests.get(id);
      if (existing !== undefined && existing !== value) {
        throw new Error("An autonomy read artifact id was reused with new content.");
      }
      digests.set(id, value);
      return id;
    },
    async getReadPage(artifactId) {
      const value = digests.get(artifactId);
      if (value === undefined) throw new Error("The autonomy read artifact is missing.");
      return parseAutonomyReadArtifact(value);
    },
    async clearRunArtifacts() {
      digests.clear();
      targets.clear();
      cursors.clear();
      candidateEffects.clear();
      records.clear();
      digestRecords.clear();
      supportCollections.clear();
      preparedRoots.clear();
    },
    async claimCandidateEffect(effectKey, recordId) {
      const record = v.parse(autonomyEvidenceRecordIdSchema, recordId);
      const values = candidateEffects.get(effectKey) ?? new Set<string>();
      values.add(record);
      candidateEffects.set(effectKey, values);
    },
    async prepareRootCatalog(args) {
      preparedRoots.set(
        args.rootDigestId,
        new Set(recordsForRoot(args.rootDigestId).map((record) => record.recordId)),
      );
      return { isDone: true };
    },
    async readCandidateEffects(args) {
      const members = preparedRoots.get(args.rootDigestId);
      if (members === undefined) throw new Error("The autonomy final root is not prepared.");
      const effects = [...candidateEffects.entries()]
        .filter(([, recordIds]) => [...recordIds].some((recordId) => members.has(recordId)))
        .filter(([effectKey]) => args.cursor === undefined || effectKey > args.cursor)
        .sort(([left], [right]) => left.localeCompare(right));
      const page = effects.slice(0, args.limit).map(([effectKey]) => effectKey);
      const hasMore = effects.length > args.limit;
      const last = page.at(-1);
      return {
        effectKeys: page,
        ...(hasMore && last !== undefined ? { cursor: last } : {}),
        isDone: !hasMore,
      };
    },
    async readCandidateEffectVariants(args) {
      const members = preparedRoots.get(args.rootDigestId);
      if (members === undefined) throw new Error("The autonomy final root is not prepared.");
      const recordIds = [...(candidateEffects.get(args.effectKey) ?? [])]
        .filter((recordId) => members.has(recordId))
        .filter((recordId) => args.cursor === undefined || recordId > args.cursor)
        .sort();
      const selected = recordIds.slice(0, args.limit);
      const page = selected.map((recordId) => {
        const value = records.get(recordId);
        if (value === undefined) {
          throw new Error("The autonomy candidate effect record is missing.");
        }
        const record = v.parse(autonomyEvidenceRecordSchema, JSON.parse(value));
        if (record.kind !== "candidate") {
          throw new Error("The autonomy candidate effect points to a finding.");
        }
        return record;
      });
      const hasMore = recordIds.length > args.limit;
      const last = page.at(-1);
      return {
        records: page,
        ...(hasMore && last !== undefined ? { cursor: last.recordId } : {}),
        isDone: !hasMore,
      };
    },
    async claimCursor(args) {
      const identity = JSON.stringify([args.read, args.snapshot, args.cursor]);
      const existing = cursors.get(identity);
      if (existing !== undefined) return existing === args.claimId;
      cursors.set(identity, args.claimId);
      return true;
    },
    async readSynthesisPairs(args) {
      return selectSynthesisPairPage({
        left: recordsForRoot(args.leftDigestId).filter((record) => record.scope === "source"),
        right: recordsForRoot(args.rightDigestId).filter((record) => record.scope === "source"),
        ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
        limit: args.limit,
      });
    },
    async readHypothesisRecords(args) {
      const values = [
        ...new Map(
          args.rootDigestIds.flatMap((rootDigestId) =>
            recordsForRoot(rootDigestId)
              .filter((record) => record.scope === "derived")
              .map((record) => [record.recordId, record] as const),
          ),
        ).values(),
      ]
        .filter(
          (record) => args.afterRecordId === undefined || record.recordId > args.afterRecordId,
        )
        .sort((left, right) => left.recordId.localeCompare(right.recordId));
      const selected = values.slice(0, args.limit);
      const page = selected.map((record) => ({ record }));
      const hasMore = values.length > args.limit;
      const last = selected.at(-1);
      return {
        records: page,
        ...(hasMore && last !== undefined ? { nextRecordId: last.recordId } : {}),
        isDone: !hasMore,
      };
    },
    async collectSupportLeaves(args) {
      let collection = supportCollections.get(args.collectionId);
      if (collection === undefined) {
        if (!records.has(args.rootRecordId)) {
          throw new Error("The autonomy support root is missing.");
        }
        collection = {
          rootRecordId: args.rootRecordId,
          frontier: new Set([args.rootRecordId]),
          seen: new Set(),
          leaves: new Map(),
          complete: false,
        };
        supportCollections.set(args.collectionId, collection);
      } else if (collection.rootRecordId !== args.rootRecordId) {
        throw new Error("The autonomy support collection id was reused.");
      }
      const pending = [...collection.frontier].sort().slice(0, args.limit);
      for (const recordId of pending) {
        collection.frontier.delete(recordId);
        if (collection.seen.has(recordId)) continue;
        collection.seen.add(recordId);
        const value = records.get(recordId);
        if (value === undefined) throw new Error("The autonomy support record is missing.");
        const record = v.parse(autonomyEvidenceRecordSchema, JSON.parse(value));
        if (record.scope === "source") {
          const citations =
            record.kind === "finding" ? record.finding.citations : record.candidate.citations;
          for (const citation of citations) {
            const canonical = canonicalAutonomyCitation(citation);
            const identity = await autonomyCitationIdentity(canonical);
            collection.leaves.set(identity, { identity, citation: canonical });
          }
        } else {
          for (const supportId of record.supportRecordIds) {
            if (!collection.seen.has(supportId)) collection.frontier.add(supportId);
          }
        }
      }
      collection.complete = collection.frontier.size === 0;
      return { isDone: collection.complete };
    },
    async readSupportLeaves(args) {
      const collection = supportCollections.get(args.collectionId);
      if (collection === undefined || !collection.complete) {
        throw new Error("The autonomy support collection is incomplete.");
      }
      const values = [...collection.leaves.values()]
        .filter((leaf) => args.afterIdentity === undefined || leaf.identity > args.afterIdentity)
        .sort((left, right) => left.identity.localeCompare(right.identity));
      const leaves = values.slice(0, args.limit);
      const hasMore = values.length > args.limit;
      const last = leaves.at(-1);
      return {
        leaves,
        ...(hasMore && last !== undefined ? { cursor: last.identity } : {}),
        isDone: !hasMore,
      };
    },
    async readCandidateRecords(args) {
      const cursor =
        args.cursor === undefined
          ? undefined
          : v.parse(autonomyEvidenceRecordIdSchema, args.cursor);
      const candidates = recordsForRoot(args.rootDigestId)
        .filter(
          (record): record is Extract<AutonomyEvidenceRecord, { kind: "candidate" }> =>
            record.kind === "candidate",
        )
        .sort((left, right) => left.recordId.localeCompare(right.recordId));
      const start =
        cursor === undefined ? 0 : candidates.findIndex((record) => record.recordId > cursor);
      if (cursor !== undefined && start === -1) {
        return { records: [], isDone: true };
      }
      const page = candidates.slice(start, start + args.limit);
      const hasMore = start + page.length < candidates.length;
      const last = page.at(-1);
      return {
        records: page,
        ...(hasMore && last !== undefined ? { cursor: last.recordId } : {}),
        isDone: !hasMore,
      };
    },
    async readFindingRecords(args) {
      const cursor =
        args.cursor === undefined
          ? undefined
          : v.parse(autonomyEvidenceRecordIdSchema, args.cursor);
      const findings = recordsForRoot(args.rootDigestId)
        .filter(
          (record): record is Extract<AutonomyEvidenceRecord, { kind: "finding" }> =>
            record.kind === "finding",
        )
        .sort((left, right) => left.recordId.localeCompare(right.recordId));
      const start =
        cursor === undefined ? 0 : findings.findIndex((record) => record.recordId > cursor);
      if (cursor !== undefined && start === -1) {
        return { records: [], isDone: true };
      }
      const page = findings.slice(start, start + args.limit);
      const hasMore = start + page.length < findings.length;
      const last = page.at(-1);
      return {
        records: page,
        ...(hasMore && last !== undefined ? { cursor: last.recordId } : {}),
        isDone: !hasMore,
      };
    },
    async getEvidenceRecord(recordId) {
      const value = records.get(v.parse(autonomyEvidenceRecordIdSchema, recordId));
      if (value === undefined) throw new Error("The autonomy evidence record is missing.");
      return v.parse(autonomyEvidenceRecordSchema, JSON.parse(value));
    },
  };
}

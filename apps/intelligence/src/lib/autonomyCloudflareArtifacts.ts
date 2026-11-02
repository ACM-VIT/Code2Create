import { getCloudflareContext } from "@flue/runtime/cloudflare";
import * as v from "valibot";

import {
  parseAutonomyReadArtifact,
  serializeAutonomyEvidenceTarget,
  serializeAutonomyReadArtifact,
  type AutonomyArtifactStore,
} from "./autonomyArtifacts.ts";
import {
  autonomyEvidenceRecordIdSchema,
  autonomyEvidenceRecordSchema,
  evidenceRecordsForDigest,
  parseSynthesisPairCursor,
  synthesisPairCursor,
  type AutonomyEvidencePair,
  type AutonomyHypothesisRecord,
  type AutonomySupportLeaf,
  autonomyCitationIdentity,
  canonicalAutonomyCitation,
} from "./autonomyCatalog.ts";
import { autonomyEvidenceDigestSchema, autonomyEvidenceTargetSchema } from "./autonomyEvidence.ts";
import { autonomyCitationSchema } from "./autonomyProtocol.ts";
import {
  firstSourceEvidenceRecordSql,
  digestHypothesisPageSql,
  nextSourceEvidenceRecordSql,
  rootCandidateEffectPageSql,
  rootCandidateVariantPageSql,
  rootEvidenceKindPageSql,
} from "./autonomyArtifactSql.ts";

type SqlStore = ReturnType<typeof getCloudflareContext>["storage"]["sql"];

const autonomyPrivateArtifactTableNames = [
  "c2c_autonomy_evidence_artifacts",
  "c2c_autonomy_evidence_targets",
  "c2c_autonomy_seen_cursors",
  "c2c_autonomy_candidate_effects",
  "c2c_autonomy_evidence_records",
  "c2c_autonomy_digest_source_records",
  "c2c_autonomy_digest_hypothesis_records",
  "c2c_autonomy_digest_children",
  "c2c_autonomy_digest_records",
  "c2c_autonomy_root_catalogs",
  "c2c_autonomy_root_frontier",
  "c2c_autonomy_root_seen",
  "c2c_autonomy_root_records",
  "c2c_autonomy_support_edges",
  "c2c_autonomy_support_collections",
  "c2c_autonomy_support_frontier",
  "c2c_autonomy_support_seen",
  "c2c_autonomy_support_leaves",
] as const;

export function purgeCloudflareAutonomyArtifacts(storage: SqlStore) {
  for (const table of autonomyPrivateArtifactTableNames) {
    storage.exec(`DELETE FROM ${table}`);
  }
}

function initialize(sql: SqlStore) {
  sql.exec(`CREATE TABLE IF NOT EXISTS c2c_autonomy_evidence_artifacts (
		id TEXT PRIMARY KEY NOT NULL,
		value TEXT NOT NULL
	)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS c2c_autonomy_evidence_targets (
		value TEXT PRIMARY KEY NOT NULL
	)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS c2c_autonomy_seen_cursors (
		identity TEXT PRIMARY KEY NOT NULL,
		claim_id TEXT NOT NULL
	)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS c2c_autonomy_candidate_effects (
		effect_key TEXT NOT NULL,
		record_id TEXT NOT NULL,
		PRIMARY KEY (effect_key, record_id)
	)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS c2c_autonomy_evidence_records (
		record_id TEXT PRIMARY KEY NOT NULL,
		kind TEXT NOT NULL CHECK (kind IN ('finding', 'candidate')),
		scope TEXT NOT NULL CHECK (scope IN ('source', 'derived')),
		source_ordinal INTEGER,
		value TEXT NOT NULL
	)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS c2c_autonomy_digest_source_records (
		digest_id TEXT NOT NULL,
		source_ordinal INTEGER NOT NULL,
		record_id TEXT NOT NULL,
		PRIMARY KEY (digest_id, source_ordinal, record_id)
	)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS c2c_autonomy_digest_hypothesis_records (
		digest_id TEXT NOT NULL,
		record_id TEXT NOT NULL,
		PRIMARY KEY (digest_id, record_id)
	)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS c2c_autonomy_digest_children (
		parent_digest_id TEXT NOT NULL,
		child_digest_id TEXT NOT NULL,
		PRIMARY KEY (parent_digest_id, child_digest_id)
	)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS c2c_autonomy_digest_records (
		digest_id TEXT NOT NULL,
		record_id TEXT NOT NULL,
		PRIMARY KEY (digest_id, record_id)
	)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS c2c_autonomy_root_catalogs (
		root_digest_id TEXT PRIMARY KEY NOT NULL,
		complete INTEGER NOT NULL CHECK (complete IN (0, 1))
	)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS c2c_autonomy_root_frontier (
		root_digest_id TEXT NOT NULL,
		digest_id TEXT NOT NULL,
		PRIMARY KEY (root_digest_id, digest_id)
	)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS c2c_autonomy_root_seen (
		root_digest_id TEXT NOT NULL,
		digest_id TEXT NOT NULL,
		PRIMARY KEY (root_digest_id, digest_id)
	)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS c2c_autonomy_root_records (
		root_digest_id TEXT NOT NULL,
		record_id TEXT NOT NULL,
		PRIMARY KEY (root_digest_id, record_id)
	)`);
  sql.exec(`CREATE INDEX IF NOT EXISTS c2c_autonomy_root_records_by_record
		ON c2c_autonomy_root_records (record_id, root_digest_id)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS c2c_autonomy_support_edges (
		record_id TEXT NOT NULL,
		support_record_id TEXT NOT NULL,
		PRIMARY KEY (record_id, support_record_id)
	)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS c2c_autonomy_support_collections (
		collection_id TEXT PRIMARY KEY NOT NULL,
		root_record_id TEXT NOT NULL,
		complete INTEGER NOT NULL CHECK (complete IN (0, 1))
	)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS c2c_autonomy_support_frontier (
		collection_id TEXT NOT NULL,
		record_id TEXT NOT NULL,
		PRIMARY KEY (collection_id, record_id)
	)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS c2c_autonomy_support_seen (
		collection_id TEXT NOT NULL,
		record_id TEXT NOT NULL,
		PRIMARY KEY (collection_id, record_id)
	)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS c2c_autonomy_support_leaves (
		collection_id TEXT NOT NULL,
		identity TEXT NOT NULL,
		citation TEXT NOT NULL,
		PRIMARY KEY (collection_id, identity)
	)`);
  sql.exec(`CREATE INDEX IF NOT EXISTS c2c_autonomy_candidate_effects_by_record
		ON c2c_autonomy_candidate_effects (record_id)`);
  sql.exec(`CREATE INDEX IF NOT EXISTS c2c_autonomy_digest_source_records_by_record
		ON c2c_autonomy_digest_source_records (record_id, digest_id)`);
  sql.exec(`CREATE INDEX IF NOT EXISTS c2c_autonomy_records_by_kind
		ON c2c_autonomy_evidence_records (kind, record_id)`);
}

function firstString(rows: Array<Record<string, unknown>>, field: string) {
  const value = rows[0]?.[field];
  return typeof value === "string" ? value : undefined;
}

function recordFromRow(row: Record<string, unknown>, field: string) {
  const value = row[field];
  if (typeof value !== "string") {
    throw new Error("The autonomy evidence catalog returned an invalid record.");
  }
  return v.parse(autonomyEvidenceRecordSchema, JSON.parse(value));
}

function requirePageLimit(limit: number) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32) {
    throw new Error("The autonomy evidence catalog page limit is invalid.");
  }
  return limit;
}

function rootRecordPage(args: {
  storage: SqlStore;
  rootDigestId: string;
  kind: "finding" | "candidate";
  cursor: string;
  limit: number;
}) {
  const rows = args.storage
    .exec(rootEvidenceKindPageSql, args.rootDigestId, args.kind, args.cursor, args.limit + 1)
    .toArray();
  const hasMore = rows.length > args.limit;
  return {
    records: rows.slice(0, args.limit).map((row) => recordFromRow(row, "value")),
    hasMore,
  };
}

function exactDescendantRecord(args: {
  storage: SqlStore;
  rootDigestId: string;
  recordId: string;
}) {
  const row = args.storage
    .exec(
      `SELECT record.value
		FROM c2c_autonomy_digest_source_records member
		JOIN c2c_autonomy_evidence_records record ON record.record_id = member.record_id
		WHERE member.digest_id = ? AND member.record_id = ?
		LIMIT 1`,
      args.rootDigestId,
      args.recordId,
    )
    .toArray()[0];
  return row === undefined ? undefined : recordFromRow(row, "value");
}

function nextDescendantRecord(args: { storage: SqlStore; rootDigestId: string; after: string }) {
  const after =
    args.after === ""
      ? undefined
      : exactDescendantRecord({
          storage: args.storage,
          rootDigestId: args.rootDigestId,
          recordId: args.after,
        });
  if (after !== undefined && after.sourceOrdinal === undefined) {
    throw new Error("The autonomy source record has no ordinal.");
  }
  const row =
    after === undefined
      ? args.storage.exec(firstSourceEvidenceRecordSql, args.rootDigestId).toArray()[0]
      : args.storage
          .exec(
            nextSourceEvidenceRecordSql,
            args.rootDigestId,
            after.sourceOrdinal,
            after.sourceOrdinal,
            args.after,
          )
          .toArray()[0];
  return row === undefined ? undefined : recordFromRow(row, "value");
}

function nextSynthesisPair(args: {
  storage: SqlStore;
  leftDigestId: string;
  rightDigestId: string;
  cursor?: { left: string; right: string };
}): AutonomyEvidencePair | undefined {
  let left =
    args.cursor === undefined
      ? nextDescendantRecord({
          storage: args.storage,
          rootDigestId: args.leftDigestId,
          after: "",
        })
      : exactDescendantRecord({
          storage: args.storage,
          rootDigestId: args.leftDigestId,
          recordId: args.cursor.left,
        });
  let right =
    left === undefined
      ? undefined
      : nextDescendantRecord({
          storage: args.storage,
          rootDigestId: args.rightDigestId,
          after: args.cursor?.right ?? "",
        });
  if (left !== undefined && right !== undefined) return { left, right };
  left = nextDescendantRecord({
    storage: args.storage,
    rootDigestId: args.leftDigestId,
    after: args.cursor?.left ?? left?.recordId ?? "",
  });
  if (left === undefined) return undefined;
  right = nextDescendantRecord({
    storage: args.storage,
    rootDigestId: args.rightDigestId,
    after: "",
  });
  return right === undefined ? undefined : { left, right };
}

/** Bounded private artifacts live in SQLite beside the owning Flue instance. */
export function cloudflareAutonomyArtifactStore(): AutonomyArtifactStore {
  const sql = () => {
    const storage = getCloudflareContext().storage.sql;
    initialize(storage);
    return storage;
  };
  return {
    async putDigest(digest) {
      const parsed = v.parse(autonomyEvidenceDigestSchema, digest);
      const value = JSON.stringify(parsed);
      const storage = sql();
      const existing = firstString(
        storage
          .exec("SELECT value FROM c2c_autonomy_evidence_artifacts WHERE id = ?", digest.digestId)
          .toArray(),
        "value",
      );
      if (existing !== undefined && existing !== value) {
        throw new Error("An autonomy evidence artifact id was reused with new content.");
      }
      if (existing === undefined)
        storage.exec(
          "INSERT INTO c2c_autonomy_evidence_artifacts (id, value) VALUES (?, ?)",
          digest.digestId,
          value,
        );
      for (const record of await evidenceRecordsForDigest(parsed)) {
        if (record.scope === "derived") {
          for (const supportRecordId of record.supportRecordIds) {
            const support = storage
              .exec(
                "SELECT record_id FROM c2c_autonomy_evidence_records WHERE record_id = ?",
                supportRecordId,
              )
              .toArray()[0];
            if (support === undefined) {
              throw new Error("A derived evidence record references unavailable support.");
            }
          }
        }
        const serialized = JSON.stringify(record);
        const existingRecord = firstString(
          storage
            .exec(
              "SELECT value FROM c2c_autonomy_evidence_records WHERE record_id = ?",
              record.recordId,
            )
            .toArray(),
          "value",
        );
        if (existingRecord !== undefined && existingRecord !== serialized) {
          throw new Error("An autonomy evidence record id was reused with new content.");
        }
        if (existingRecord === undefined)
          storage.exec(
            `INSERT INTO c2c_autonomy_evidence_records
						(record_id, kind, scope, source_ordinal, value)
					VALUES (?, ?, ?, ?, ?)`,
            record.recordId,
            record.kind,
            record.scope,
            record.sourceOrdinal ?? null,
            serialized,
          );
        if (record.scope === "derived")
          storage.exec(
            `INSERT OR IGNORE INTO c2c_autonomy_digest_hypothesis_records
						(digest_id, record_id) VALUES (?, ?)`,
            parsed.digestId,
            record.recordId,
          );
        for (const supportRecordId of record.supportRecordIds)
          storage.exec(
            `INSERT OR IGNORE INTO c2c_autonomy_support_edges
						(record_id, support_record_id) VALUES (?, ?)`,
            record.recordId,
            supportRecordId,
          );
        storage.exec(
          `INSERT OR IGNORE INTO c2c_autonomy_digest_records
						(digest_id, record_id) VALUES (?, ?)`,
          parsed.digestId,
          record.recordId,
        );
        if (record.scope === "source" && record.sourceOrdinal !== undefined)
          storage.exec(
            `INSERT OR IGNORE INTO c2c_autonomy_digest_source_records
						(digest_id, source_ordinal, record_id) VALUES (?, ?, ?)`,
            parsed.digestId,
            record.sourceOrdinal,
            record.recordId,
          );
      }
      for (const childDigestId of parsed.children) {
        storage.exec(
          `INSERT OR IGNORE INTO c2c_autonomy_digest_children
						(parent_digest_id, child_digest_id) VALUES (?, ?)`,
          parsed.digestId,
          childDigestId,
        );
        storage.exec(
          `INSERT OR IGNORE INTO c2c_autonomy_digest_hypothesis_records
						(digest_id, record_id)
					SELECT ?, record_id FROM c2c_autonomy_digest_hypothesis_records
					WHERE digest_id = ?`,
          parsed.digestId,
          childDigestId,
        );
        storage.exec(
          `INSERT OR IGNORE INTO c2c_autonomy_digest_source_records
						(digest_id, source_ordinal, record_id)
					SELECT ?, source_ordinal, record_id
					FROM c2c_autonomy_digest_source_records WHERE digest_id = ?`,
          parsed.digestId,
          childDigestId,
        );
      }
    },
    async getDigest(digestId) {
      const value = firstString(
        sql()
          .exec("SELECT value FROM c2c_autonomy_evidence_artifacts WHERE id = ?", digestId)
          .toArray(),
        "value",
      );
      if (value === undefined) throw new Error("The autonomy evidence artifact is missing.");
      return v.parse(autonomyEvidenceDigestSchema, JSON.parse(value));
    },
    async putTargets(targets) {
      const storage = sql();
      for (const target of targets) {
        const value = serializeAutonomyEvidenceTarget(
          v.parse(autonomyEvidenceTargetSchema, target),
        );
        storage.exec(
          "INSERT OR IGNORE INTO c2c_autonomy_evidence_targets (value) VALUES (?)",
          value,
        );
      }
    },
    async hasTarget(target) {
      const value = serializeAutonomyEvidenceTarget(v.parse(autonomyEvidenceTargetSchema, target));
      return (
        sql()
          .exec("SELECT value FROM c2c_autonomy_evidence_targets WHERE value = ?", value)
          .toArray().length === 1
      );
    },
    async putReadPage(receipt) {
      const id = `read-${receipt.operationId}`;
      const value = JSON.stringify(serializeAutonomyReadArtifact(receipt));
      const storage = sql();
      const existing = firstString(
        storage
          .exec("SELECT value FROM c2c_autonomy_evidence_artifacts WHERE id = ?", id)
          .toArray(),
        "value",
      );
      if (existing !== undefined && existing !== value) {
        throw new Error("An autonomy read artifact id was reused with new content.");
      }
      if (existing === undefined)
        storage.exec(
          "INSERT INTO c2c_autonomy_evidence_artifacts (id, value) VALUES (?, ?)",
          id,
          value,
        );
      return id;
    },
    async getReadPage(artifactId) {
      const value = firstString(
        sql()
          .exec("SELECT value FROM c2c_autonomy_evidence_artifacts WHERE id = ?", artifactId)
          .toArray(),
        "value",
      );
      if (value === undefined) throw new Error("The autonomy read artifact is missing.");
      return parseAutonomyReadArtifact(value);
    },
    async clearRunArtifacts() {
      purgeCloudflareAutonomyArtifacts(sql());
    },
    async claimCandidateEffect(effectKey, recordId) {
      sql().exec(
        "INSERT OR IGNORE INTO c2c_autonomy_candidate_effects (effect_key, record_id) VALUES (?, ?)",
        effectKey,
        v.parse(autonomyEvidenceRecordIdSchema, recordId),
      );
    },
    async prepareRootCatalog(args) {
      const limit = requirePageLimit(args.limit);
      const storage = sql();
      const catalog = storage
        .exec(
          "SELECT complete FROM c2c_autonomy_root_catalogs WHERE root_digest_id = ?",
          args.rootDigestId,
        )
        .toArray()[0];
      if (catalog === undefined) {
        const root = storage
          .exec("SELECT id FROM c2c_autonomy_evidence_artifacts WHERE id = ?", args.rootDigestId)
          .toArray()[0];
        if (root === undefined) throw new Error("The autonomy final root is missing.");
        storage.exec(
          "INSERT INTO c2c_autonomy_root_catalogs (root_digest_id, complete) VALUES (?, 0)",
          args.rootDigestId,
        );
        storage.exec(
          "INSERT INTO c2c_autonomy_root_frontier (root_digest_id, digest_id) VALUES (?, ?)",
          args.rootDigestId,
          args.rootDigestId,
        );
      } else if (catalog["complete"] === 1) {
        return { isDone: true };
      }
      const frontier = storage
        .exec(
          `SELECT digest_id FROM c2c_autonomy_root_frontier
				WHERE root_digest_id = ? ORDER BY digest_id LIMIT ?`,
          args.rootDigestId,
          limit,
        )
        .toArray();
      for (const row of frontier) {
        const digestId = row["digest_id"];
        if (typeof digestId !== "string") throw new Error("The root frontier is invalid.");
        storage.exec(
          "DELETE FROM c2c_autonomy_root_frontier WHERE root_digest_id = ? AND digest_id = ?",
          args.rootDigestId,
          digestId,
        );
        const seen = storage
          .exec(
            "SELECT digest_id FROM c2c_autonomy_root_seen WHERE root_digest_id = ? AND digest_id = ?",
            args.rootDigestId,
            digestId,
          )
          .toArray()[0];
        if (seen !== undefined) continue;
        storage.exec(
          "INSERT INTO c2c_autonomy_root_seen (root_digest_id, digest_id) VALUES (?, ?)",
          args.rootDigestId,
          digestId,
        );
        storage.exec(
          `INSERT OR IGNORE INTO c2c_autonomy_root_records (root_digest_id, record_id)
					SELECT ?, record_id FROM c2c_autonomy_digest_records WHERE digest_id = ?`,
          args.rootDigestId,
          digestId,
        );
        storage.exec(
          `INSERT OR IGNORE INTO c2c_autonomy_root_frontier (root_digest_id, digest_id)
					SELECT ?, child_digest_id FROM c2c_autonomy_digest_children
					WHERE parent_digest_id = ? AND child_digest_id NOT IN (
						SELECT digest_id FROM c2c_autonomy_root_seen WHERE root_digest_id = ?
					)`,
          args.rootDigestId,
          digestId,
          args.rootDigestId,
        );
      }
      const pending = storage
        .exec(
          "SELECT digest_id FROM c2c_autonomy_root_frontier WHERE root_digest_id = ? LIMIT 1",
          args.rootDigestId,
        )
        .toArray()[0];
      const isDone = pending === undefined;
      if (isDone)
        storage.exec(
          "UPDATE c2c_autonomy_root_catalogs SET complete = 1 WHERE root_digest_id = ?",
          args.rootDigestId,
        );
      return { isDone };
    },
    async readCandidateEffects(args) {
      const limit = requirePageLimit(args.limit);
      const cursor = args.cursor ?? "";
      const effectRows = sql()
        .exec(rootCandidateEffectPageSql, args.rootDigestId, cursor, limit + 1)
        .toArray();
      const hasMore = effectRows.length > limit;
      const effectKeys = effectRows.slice(0, limit).map((effectRow) => {
        const effectKey = effectRow["effect_key"];
        if (typeof effectKey !== "string") {
          throw new Error("The autonomy candidate effect key is invalid.");
        }
        return effectKey;
      });
      const last = effectKeys.at(-1);
      return {
        effectKeys,
        ...(hasMore && last !== undefined ? { cursor: last } : {}),
        isDone: !hasMore,
      };
    },
    async readCandidateEffectVariants(args) {
      const limit = requirePageLimit(args.limit);
      const cursor =
        args.cursor === undefined ? "" : v.parse(autonomyEvidenceRecordIdSchema, args.cursor);
      const rows = sql()
        .exec(rootCandidateVariantPageSql, args.rootDigestId, args.effectKey, cursor, limit + 1)
        .toArray();
      const hasMore = rows.length > limit;
      const records = rows.slice(0, limit).map((row) => {
        const record = recordFromRow(row, "value");
        if (record.kind !== "candidate") {
          throw new Error("The autonomy candidate effect points to a finding.");
        }
        return record;
      });
      const last = records.at(-1);
      return {
        records,
        ...(hasMore && last !== undefined ? { cursor: last.recordId } : {}),
        isDone: !hasMore,
      };
    },
    async claimCursor(args) {
      const identity = JSON.stringify([args.read, args.snapshot, args.cursor]);
      const storage = sql();
      const existingClaim = firstString(
        storage
          .exec("SELECT claim_id FROM c2c_autonomy_seen_cursors WHERE identity = ?", identity)
          .toArray(),
        "claim_id",
      );
      if (existingClaim !== undefined) return existingClaim === args.claimId;
      storage.exec(
        "INSERT INTO c2c_autonomy_seen_cursors (identity, claim_id) VALUES (?, ?)",
        identity,
        args.claimId,
      );
      return true;
    },
    async readSynthesisPairs(args) {
      const limit = requirePageLimit(args.limit);
      const cursor = args.cursor === undefined ? undefined : parseSynthesisPairCursor(args.cursor);
      if (cursor === null) throw new Error("The autonomy synthesis cursor is invalid.");
      const storage = sql();
      const pairs: AutonomyEvidencePair[] = [];
      let nextCursor = cursor;
      for (let index = 0; index < limit + 1; index += 1) {
        const pair = nextSynthesisPair({
          storage,
          leftDigestId: args.leftDigestId,
          rightDigestId: args.rightDigestId,
          ...(nextCursor === undefined ? {} : { cursor: nextCursor }),
        });
        if (pair === undefined) break;
        pairs.push(pair);
        nextCursor = { left: pair.left.recordId, right: pair.right.recordId };
      }
      const hasMore = pairs.length > limit;
      if (hasMore) pairs.pop();
      const last = pairs.at(-1);
      return {
        pairs,
        ...(hasMore && last !== undefined ? { cursor: synthesisPairCursor(last) } : {}),
        isDone: !hasMore,
      };
    },
    async readHypothesisRecords(args) {
      const limit = requirePageLimit(args.limit);
      if (args.rootDigestIds.length < 1 || args.rootDigestIds.length > 3) {
        throw new Error("The autonomy hypothesis roots are invalid.");
      }
      const cursor =
        args.afterRecordId === undefined
          ? ""
          : v.parse(autonomyEvidenceRecordIdSchema, args.afterRecordId);
      const rows = sql()
        .exec(
          digestHypothesisPageSql(args.rootDigestIds.length),
          ...args.rootDigestIds,
          cursor,
          limit + 1,
        )
        .toArray();
      const hasMore = rows.length > limit;
      const records: AutonomyHypothesisRecord[] = rows.slice(0, limit).map((row) => {
        return { record: recordFromRow(row, "value") };
      });
      const last = records.at(-1);
      return {
        records,
        ...(hasMore && last !== undefined ? { nextRecordId: last.record.recordId } : {}),
        isDone: !hasMore,
      };
    },
    async collectSupportLeaves(args) {
      const limit = requirePageLimit(args.limit);
      const storage = sql();
      const collection = storage
        .exec(
          `SELECT root_record_id, complete
				FROM c2c_autonomy_support_collections WHERE collection_id = ?`,
          args.collectionId,
        )
        .toArray()[0];
      if (collection === undefined) {
        const root = storage
          .exec(
            "SELECT record_id FROM c2c_autonomy_evidence_records WHERE record_id = ?",
            args.rootRecordId,
          )
          .toArray()[0];
        if (root === undefined) throw new Error("The autonomy support root is missing.");
        storage.exec(
          `INSERT INTO c2c_autonomy_support_collections
						(collection_id, root_record_id, complete) VALUES (?, ?, 0)`,
          args.collectionId,
          args.rootRecordId,
        );
        storage.exec(
          `INSERT INTO c2c_autonomy_support_frontier
						(collection_id, record_id) VALUES (?, ?)`,
          args.collectionId,
          args.rootRecordId,
        );
      } else {
        if (collection["root_record_id"] !== args.rootRecordId) {
          throw new Error("The autonomy support collection id was reused.");
        }
        if (collection["complete"] === 1) return { isDone: true };
      }
      const frontier = storage
        .exec(
          `SELECT record_id FROM c2c_autonomy_support_frontier
				WHERE collection_id = ? ORDER BY record_id LIMIT ?`,
          args.collectionId,
          limit,
        )
        .toArray();
      for (const row of frontier) {
        const recordId = row["record_id"];
        if (typeof recordId !== "string") {
          throw new Error("The autonomy support frontier is invalid.");
        }
        storage.exec(
          "DELETE FROM c2c_autonomy_support_frontier WHERE collection_id = ? AND record_id = ?",
          args.collectionId,
          recordId,
        );
        const alreadySeen = storage
          .exec(
            "SELECT record_id FROM c2c_autonomy_support_seen WHERE collection_id = ? AND record_id = ?",
            args.collectionId,
            recordId,
          )
          .toArray()[0];
        if (alreadySeen !== undefined) continue;
        storage.exec(
          "INSERT INTO c2c_autonomy_support_seen (collection_id, record_id) VALUES (?, ?)",
          args.collectionId,
          recordId,
        );
        const recordRow = storage
          .exec("SELECT value FROM c2c_autonomy_evidence_records WHERE record_id = ?", recordId)
          .toArray()[0];
        if (recordRow === undefined) throw new Error("The autonomy support record is missing.");
        const record = recordFromRow(recordRow, "value");
        if (record.scope === "source") {
          const citations =
            record.kind === "finding" ? record.finding.citations : record.candidate.citations;
          for (const citation of citations) {
            const canonical = canonicalAutonomyCitation(citation);
            const identity = await autonomyCitationIdentity(canonical);
            storage.exec(
              `INSERT OR IGNORE INTO c2c_autonomy_support_leaves
								(collection_id, identity, citation) VALUES (?, ?, ?)`,
              args.collectionId,
              identity,
              JSON.stringify(canonical),
            );
          }
        } else {
          for (const supportRecordId of record.supportRecordIds)
            storage.exec(
              `INSERT OR IGNORE INTO c2c_autonomy_support_frontier
							(collection_id, record_id)
						SELECT ?, ? WHERE NOT EXISTS (
							SELECT 1 FROM c2c_autonomy_support_seen
							WHERE collection_id = ? AND record_id = ?
						)`,
              args.collectionId,
              supportRecordId,
              args.collectionId,
              supportRecordId,
            );
        }
      }
      const pending = storage
        .exec(
          "SELECT record_id FROM c2c_autonomy_support_frontier WHERE collection_id = ? LIMIT 1",
          args.collectionId,
        )
        .toArray()[0];
      const isDone = pending === undefined;
      if (isDone)
        storage.exec(
          "UPDATE c2c_autonomy_support_collections SET complete = 1 WHERE collection_id = ?",
          args.collectionId,
        );
      return { isDone };
    },
    async readSupportLeaves(args) {
      const limit = requirePageLimit(args.limit);
      const storage = sql();
      const collection = storage
        .exec(
          "SELECT complete FROM c2c_autonomy_support_collections WHERE collection_id = ?",
          args.collectionId,
        )
        .toArray()[0];
      if (collection?.["complete"] !== 1) {
        throw new Error("The autonomy support collection is incomplete.");
      }
      const rows = storage
        .exec(
          `SELECT identity, citation FROM c2c_autonomy_support_leaves
				WHERE collection_id = ? AND identity > ?
				ORDER BY identity LIMIT ?`,
          args.collectionId,
          args.afterIdentity ?? "",
          limit + 1,
        )
        .toArray();
      const hasMore = rows.length > limit;
      const leaves: AutonomySupportLeaf[] = rows.slice(0, limit).map((row) => {
        const identity = row["identity"];
        const citation = row["citation"];
        if (typeof identity !== "string" || typeof citation !== "string") {
          throw new Error("The autonomy support leaf is invalid.");
        }
        return {
          identity,
          citation: v.parse(autonomyCitationSchema, JSON.parse(citation)),
        };
      });
      const last = leaves.at(-1);
      return {
        leaves,
        ...(hasMore && last !== undefined ? { cursor: last.identity } : {}),
        isDone: !hasMore,
      };
    },
    async readCandidateRecords(args) {
      const limit = requirePageLimit(args.limit);
      const cursor =
        args.cursor === undefined ? "" : v.parse(autonomyEvidenceRecordIdSchema, args.cursor);
      const page = rootRecordPage({
        storage: sql(),
        rootDigestId: args.rootDigestId,
        kind: "candidate",
        cursor,
        limit,
      });
      const records = page.records.map((record) => {
        if (record.kind !== "candidate") {
          throw new Error("The autonomy candidate catalog returned a finding.");
        }
        return record;
      });
      const last = records.at(-1);
      return {
        records,
        ...(page.hasMore && last !== undefined ? { cursor: last.recordId } : {}),
        isDone: !page.hasMore,
      };
    },
    async readFindingRecords(args) {
      const limit = requirePageLimit(args.limit);
      const cursor =
        args.cursor === undefined ? "" : v.parse(autonomyEvidenceRecordIdSchema, args.cursor);
      const page = rootRecordPage({
        storage: sql(),
        rootDigestId: args.rootDigestId,
        kind: "finding",
        cursor,
        limit,
      });
      const records = page.records.map((record) => {
        if (record.kind !== "finding") {
          throw new Error("The autonomy finding catalog returned a candidate.");
        }
        return record;
      });
      const last = records.at(-1);
      return {
        records,
        ...(page.hasMore && last !== undefined ? { cursor: last.recordId } : {}),
        isDone: !page.hasMore,
      };
    },
    async getEvidenceRecord(recordId) {
      const parsedId = v.parse(autonomyEvidenceRecordIdSchema, recordId);
      const value = firstString(
        sql()
          .exec("SELECT value FROM c2c_autonomy_evidence_records WHERE record_id = ?", parsedId)
          .toArray(),
        "value",
      );
      if (value === undefined) throw new Error("The autonomy evidence record is missing.");
      return v.parse(autonomyEvidenceRecordSchema, JSON.parse(value));
    },
  };
}

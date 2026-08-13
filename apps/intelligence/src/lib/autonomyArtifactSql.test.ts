import { DatabaseSync } from 'node:sqlite';
import { describe, expect, test } from 'vitest';

import {
	firstSourceEvidenceRecordSql,
	digestHypothesisPageSql,
	nextSourceEvidenceRecordSql,
	rootCandidateEffectPageSql,
	rootCandidateVariantPageSql,
	rootEvidenceKindPageSql,
} from './autonomyArtifactSql.ts';

function queryDetail(row: Record<string, unknown>) {
	const value = row['detail'];
	if (typeof value !== 'string') throw new Error('SQLite returned no query-plan detail.');
	return value;
}

describe('autonomy evidence SQL', () => {
	test('advances explicit digest source membership and excludes same-ordinal orphan records', () => {
		const database = new DatabaseSync(':memory:');
		database.exec(`CREATE TABLE c2c_autonomy_evidence_records (
			record_id TEXT PRIMARY KEY NOT NULL,
			kind TEXT NOT NULL,
			scope TEXT NOT NULL,
			source_ordinal INTEGER,
			value TEXT NOT NULL
		)`);
		database.exec(`CREATE TABLE c2c_autonomy_digest_source_records (
			digest_id TEXT NOT NULL,
			source_ordinal INTEGER NOT NULL,
			record_id TEXT NOT NULL,
			PRIMARY KEY (digest_id, source_ordinal, record_id)
		)`);
		database.exec(`CREATE TABLE c2c_autonomy_digest_hypothesis_records (
			digest_id TEXT NOT NULL,
			record_id TEXT NOT NULL,
			PRIMARY KEY (digest_id, record_id)
		)`);
		database.exec(`CREATE INDEX c2c_autonomy_records_by_kind
			ON c2c_autonomy_evidence_records (kind, record_id)`);
		const insert = database.prepare(`INSERT INTO c2c_autonomy_evidence_records
			(record_id, kind, scope, source_ordinal, value) VALUES (?, ?, ?, ?, ?)`);
		for (let index = 0; index < 20_000; index += 1) {
			insert.run(
				`record-${index.toString(16).padStart(64, '0')}`,
				index % 2 === 0 ? 'finding' : 'candidate',
				'source',
				index,
				JSON.stringify({ index }),
			);
		}
		const addSourceMember = database.prepare(
			`INSERT INTO c2c_autonomy_digest_source_records
				(digest_id, source_ordinal, record_id) VALUES (?, ?, ?)`,
		);
		for (let index = 10_000; index < 20_000; index += 1) {
			if (index === 15_001) continue;
			addSourceMember.run(
				'root-sources',
				index,
				`record-${index.toString(16).padStart(64, '0')}`,
			);
		}
		const sameOrdinalOrphan = `record-${(20_001).toString(16).padStart(64, '0')}`;
		insert.run(
			sameOrdinalOrphan,
			'finding',
			'source',
			15_002,
			JSON.stringify({ index: 'same-ordinal-orphan' }),
		);

		const firstPlan = database.prepare(
			`EXPLAIN QUERY PLAN ${firstSourceEvidenceRecordSql}`,
		).all('root-sources').map(queryDetail).join(' ');
		const nextPlan = database.prepare(
			`EXPLAIN QUERY PLAN ${nextSourceEvidenceRecordSql}`,
		).all('root-sources', 15_000, 15_000, `record-${'0'.repeat(64)}`)
			.map(queryDetail).join(' ');
		database.exec(`CREATE TABLE c2c_autonomy_root_records (
			root_digest_id TEXT NOT NULL,
			record_id TEXT NOT NULL,
			PRIMARY KEY (root_digest_id, record_id)
		)`);
		database.exec(`CREATE TABLE c2c_autonomy_candidate_effects (
			effect_key TEXT NOT NULL,
			record_id TEXT NOT NULL,
			PRIMARY KEY (effect_key, record_id)
		)`);
		database.exec(`CREATE INDEX c2c_autonomy_root_records_by_record
			ON c2c_autonomy_root_records (record_id, root_digest_id)`);
		const member = database.prepare(
			'INSERT INTO c2c_autonomy_root_records (root_digest_id, record_id) VALUES (?, ?)',
		);
		const effect = database.prepare(
			'INSERT INTO c2c_autonomy_candidate_effects (effect_key, record_id) VALUES (?, ?)',
		);
		const committed = `record-${(19_998).toString(16).padStart(64, '0')}`;
		const orphan = `record-${(19_999).toString(16).padStart(64, '0')}`;
		member.run('root-committed', committed);
		effect.run('effect-committed', committed);
		effect.run('effect-orphan', orphan);
		const kindPlan = database.prepare(
			`EXPLAIN QUERY PLAN ${rootEvidenceKindPageSql}`,
		).all('root-committed', 'finding', '', 9).map(queryDetail).join(' ');

		expect(firstPlan).toContain('c2c_autonomy_digest_source_records');
		expect(nextPlan).toContain('c2c_autonomy_digest_source_records');
		expect(kindPlan).toContain('c2c_autonomy_records_by_kind');
		expect(`${firstPlan} ${nextPlan} ${kindPlan}`).not.toMatch(/RECURSIVE|TEMP B-TREE/u);
		const next = database.prepare(nextSourceEvidenceRecordSql).get(
			'root-sources',
			15_000,
			15_000,
			`record-${'f'.repeat(64)}`,
		);
		expect(next).toEqual({ value: JSON.stringify({ index: 15_002 }) });
		expect(database.prepare(firstSourceEvidenceRecordSql).all('uncommitted-root')).toEqual([]);
		const committedHypothesis = `record-${(19_996).toString(16).padStart(64, '0')}`;
		const orphanHypothesis = `record-${(19_997).toString(16).padStart(64, '0')}`;
		database.prepare(
			'INSERT INTO c2c_autonomy_digest_hypothesis_records (digest_id, record_id) VALUES (?, ?)',
		).run('root-hypotheses', committedHypothesis);
		database.prepare(
			'INSERT INTO c2c_autonomy_digest_hypothesis_records (digest_id, record_id) VALUES (?, ?)',
		).run('orphan-hypotheses', orphanHypothesis);
		expect(database.prepare(digestHypothesisPageSql(1)).all(
			'root-hypotheses', '', 4,
		)).toEqual([{
			record_id: committedHypothesis,
			value: JSON.stringify({ index: 19_996 }),
		}]);
		expect(database.prepare(rootCandidateEffectPageSql).all(
			'root-committed', '', 3,
		)).toEqual([{ effect_key: 'effect-committed' }]);
		expect(database.prepare(rootCandidateVariantPageSql).all(
			'root-committed', 'effect-committed', '', 3,
		)).toEqual([{ value: JSON.stringify({ index: 19_998 }) }]);
		expect(database.prepare(rootCandidateVariantPageSql).all(
			'root-committed', 'effect-orphan', '', 3,
		)).toEqual([]);
		database.close();
	});
});

/** Indexed range scans used by the private autonomy evidence catalog. */
export const firstSourceEvidenceRecordSql = `SELECT value
FROM c2c_autonomy_digest_source_records member
JOIN c2c_autonomy_evidence_records record ON record.record_id = member.record_id
WHERE member.digest_id = ?
ORDER BY member.source_ordinal, member.record_id
LIMIT 1`;

export const nextSourceEvidenceRecordSql = `SELECT value
FROM c2c_autonomy_digest_source_records member
JOIN c2c_autonomy_evidence_records record ON record.record_id = member.record_id
WHERE member.digest_id = ? AND (
	member.source_ordinal > ? OR
	(member.source_ordinal = ? AND member.record_id > ?)
)
ORDER BY member.source_ordinal, member.record_id
LIMIT 1`;

export const rootEvidenceKindPageSql = `SELECT record.value
FROM c2c_autonomy_root_records member
JOIN c2c_autonomy_evidence_records record ON record.record_id = member.record_id
WHERE member.root_digest_id = ? AND record.kind = ? AND record.record_id > ?
ORDER BY record.record_id
LIMIT ?`;

export const rootCandidateEffectPageSql = `SELECT effect.effect_key
FROM c2c_autonomy_candidate_effects effect
JOIN c2c_autonomy_root_records member ON member.record_id = effect.record_id
WHERE member.root_digest_id = ? AND effect.effect_key > ?
GROUP BY effect.effect_key
ORDER BY effect.effect_key
LIMIT ?`;

export const rootCandidateVariantPageSql = `SELECT record.value
FROM c2c_autonomy_candidate_effects effect
JOIN c2c_autonomy_evidence_records record ON record.record_id = effect.record_id
JOIN c2c_autonomy_root_records member ON member.record_id = effect.record_id
WHERE member.root_digest_id = ? AND effect.effect_key = ? AND effect.record_id > ?
ORDER BY effect.record_id
LIMIT ?`;

export function digestHypothesisPageSql(rootCount: number) {
	if (!Number.isSafeInteger(rootCount) || rootCount < 1 || rootCount > 3) {
		throw new Error('The autonomy hypothesis root count is invalid.');
	}
	const placeholders = Array.from({ length: rootCount }, () => '?').join(', ');
	return `SELECT hypothesis.record_id, record.value
FROM c2c_autonomy_digest_hypothesis_records hypothesis
JOIN c2c_autonomy_evidence_records record ON record.record_id = hypothesis.record_id
WHERE hypothesis.digest_id IN (${placeholders}) AND hypothesis.record_id > ?
GROUP BY hypothesis.record_id
ORDER BY hypothesis.record_id
LIMIT ?`;
}

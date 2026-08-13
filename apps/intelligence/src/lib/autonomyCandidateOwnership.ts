import type { AutonomyArtifactStore } from './autonomyArtifacts.ts';
import { evidenceRecordsForDigest } from './autonomyCatalog.ts';
import type { AutonomyEvidenceDigest } from './autonomyEvidence.ts';
import { normalizeRecommendationArguments } from './autonomyExecution.ts';
import { autonomyProposalKey } from './autonomyProposal.ts';

/** Indexes every same-effect variant; ordering never chooses the winner. */
export async function registerDigestCandidateEffects(args: {
	eventSlug: string;
	digest: AutonomyEvidenceDigest;
	artifacts: AutonomyArtifactStore;
}) {
	for (const record of await evidenceRecordsForDigest(args.digest)) {
		if (record.kind !== 'candidate') continue;
		const effectKey = await autonomyProposalKey({
			eventSlug: args.eventSlug,
			arguments: normalizeRecommendationArguments(record.candidate.arguments),
		});
		await args.artifacts.claimCandidateEffect(effectKey, record.recordId);
	}
}

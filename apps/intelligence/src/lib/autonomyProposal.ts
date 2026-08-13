import type { IntelligenceRecommendationArguments } from '@code2create/domain';

const encoder = new TextEncoder();

function hexadecimal(bytes: Uint8Array) {
	return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Effect identity is trusted code, not model output. The event and exact
 * versioned command make an identical recommendation converge across runs.
 */
export async function autonomyProposalKey(args: {
	eventSlug: string;
	arguments: IntelligenceRecommendationArguments;
}) {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		encoder.encode(JSON.stringify({
			eventSlug: args.eventSlug,
			arguments: args.arguments,
		})),
	);
	return `autonomy-${hexadecimal(new Uint8Array(digest))}`;
}


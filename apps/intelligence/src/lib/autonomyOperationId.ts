const encoder = new TextEncoder();

function hexadecimal(bytes: Uint8Array) {
	return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Stable, protocol-bounded identity for one durable external effect. The
 * unhashed coordinates still travel in the signed request body where needed.
 */
export async function autonomyOperationId(
	kind: 'callback' | 'delegation' | 'model' | 'read' | 'recommendation',
	coordinates: readonly string[],
) {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		encoder.encode(JSON.stringify([kind, ...coordinates])),
	);
	return `autonomy-${kind}-${hexadecimal(new Uint8Array(digest))}`;
}

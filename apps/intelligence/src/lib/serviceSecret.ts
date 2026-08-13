const minimumServiceSecretBytes = 32;
const encoder = new TextEncoder();

/** Rejects misconfigured HMAC keys before any service request is trusted or signed. */
export function requireStrongServiceSecret(secret: string, bindingName: string) {
	if (encoder.encode(secret).byteLength < minimumServiceSecretBytes) {
		throw new Error(`${bindingName} must contain at least 32 UTF-8 bytes.`);
	}
	return secret;
}

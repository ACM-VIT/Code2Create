/** Parses one configured internal service endpoint and rejects ambiguous URL forms. */
export function serviceUrl(value: string, label: string) {
	const url = new URL(value);
	const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
	if (
		(url.protocol !== 'https:' && !(local && url.protocol === 'http:')) ||
		url.username !== '' ||
		url.password !== '' ||
		url.search !== '' ||
		url.hash !== ''
	) {
		throw new Error(`The ${label} endpoint must be an exact HTTPS URL outside local development.`);
	}
	return url;
}

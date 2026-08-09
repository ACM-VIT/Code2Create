/**
 * Evaluation-only stand-in for the Worker's `cloudflare:workers` module,
 * aliased by `vitest.eval.config.ts`. The agent reads its callback bindings at
 * delivery time, so these accessors resolve after the evaluation harness has
 * bound its local callback server.
 */

function binding(name: string): string {
	const value = process.env[name];
	if (value === undefined || value === '') {
		throw new Error(`The operations brief evaluation did not configure ${name}.`);
	}
	return value;
}

export const env = {
	get CONVEX_INTELLIGENCE_CALLBACK_URL(): string {
		return binding('CONVEX_INTELLIGENCE_CALLBACK_URL');
	},
	get INTELLIGENCE_CALLBACK_SECRET(): string {
		return binding('INTELLIGENCE_CALLBACK_SECRET');
	},
};

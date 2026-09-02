import { Hono } from 'hono';

import { requireStrongServiceSecret } from '../lib/serviceSecret.ts';
import { serviceUrl } from '../lib/serviceUrl.ts';
import { postHogIntelligenceObservabilityConfigured } from '../lib/posthogObservability.ts';

function requireExactOpsOrigin(value: string) {
	const url = new URL(value);
	const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
	if (
		(url.protocol !== 'https:' && !(local && url.protocol === 'http:')) ||
		url.origin !== value ||
		url.username !== '' ||
		url.password !== ''
	) throw new Error('OPS_ORIGIN must be an exact HTTPS origin outside local development.');
}

export const healthRoutes = new Hono<{ Bindings: Cloudflare.Env }>();

healthRoutes.get('/health', (context) => {
	try {
		if (context.env.OPENAI_API_KEY.trim().length === 0) {
			throw new Error('OPENAI_API_KEY is unavailable.');
		}
		if (
			context.env.C2C_DEPLOYMENT_ENVIRONMENT !== undefined
			&& context.env.C2C_DEPLOYMENT_ENVIRONMENT !== 'development'
			&& !postHogIntelligenceObservabilityConfigured(context.env)
		) {
			throw new Error('PostHog AI observability is unavailable.');
		}
		for (const [value, name] of [
			[context.env.INTELLIGENCE_INGRESS_SECRET, 'INTELLIGENCE_INGRESS_SECRET'],
			[context.env.INTELLIGENCE_CALLBACK_SECRET, 'INTELLIGENCE_CALLBACK_SECRET'],
			[context.env.INTELLIGENCE_READ_SECRET, 'INTELLIGENCE_READ_SECRET'],
			[context.env.INTELLIGENCE_STREAM_SECRET, 'INTELLIGENCE_STREAM_SECRET'],
		] as const) requireStrongServiceSecret(value, name);
		requireExactOpsOrigin(context.env.OPS_ORIGIN);
		for (const [value, name] of [
			[context.env.CONVEX_INTELLIGENCE_CALLBACK_URL, 'Convex intelligence callback'],
			[context.env.CONVEX_INTELLIGENCE_READ_URL, 'Convex intelligence read'],
			[context.env.CONVEX_INTELLIGENCE_RECOMMENDATION_URL, 'Convex recommendation'],
			[context.env.CONVEX_INTELLIGENCE_EPISODE_READ_URL, 'Convex episode read'],
			[context.env.CONVEX_INTELLIGENCE_EPISODE_CALLBACK_URL, 'Convex episode callback'],
			[context.env.CONVEX_INTELLIGENCE_IDEA_READ_URL, 'Convex idea read'],
			[context.env.CONVEX_INTELLIGENCE_IDEA_CALLBACK_URL, 'Convex idea callback'],
			[context.env.CONVEX_INTELLIGENCE_AUTONOMY_CALLBACK_URL, 'Convex autonomy callback'],
			[context.env.CONVEX_INTELLIGENCE_AUTONOMY_READ_URL, 'Convex autonomy read'],
			[context.env.CONVEX_INTELLIGENCE_AUTONOMY_WORK_URL, 'Convex autonomy work authorization'],
			[context.env.CONVEX_INTELLIGENCE_AUTONOMY_RECOMMENDATION_URL, 'Convex autonomy recommendation'],
			[
				context.env.CONVEX_INTELLIGENCE_AUTONOMY_RECOMMENDATION_EVIDENCE_URL,
				'Convex autonomy recommendation evidence',
			],
		] as const) serviceUrl(value, name);
		return context.json({ ok: true });
	} catch {
		return context.json({ ok: false }, 503);
	}
});

import { instrument } from '@flue/runtime';
import { createCloudflareTracing } from '@flue/runtime/cloudflare';
import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import { createAutonomyInstrumentation } from './lib/autonomyInstrumentation.ts';
import { autonomyRoutes } from './routes/autonomyRoutes.ts';
import { briefRoutes } from './routes/briefRoutes.ts';
import { copilotRoutes } from './routes/copilotRoutes.ts';
import { episodeRoutes } from './routes/episodeRoutes.ts';
import { healthRoutes } from './routes/healthRoutes.ts';
import { ideaRoutes } from './routes/ideaRoutes.ts';
import { streamRoutes } from './routes/streamRoutes.ts';

instrument(createCloudflareTracing({ content: false }));
instrument(createAutonomyInstrumentation(env));

const app = new Hono<{ Bindings: Cloudflare.Env }>();

app.route('/', healthRoutes);
app.route('/', streamRoutes);
app.route('/', autonomyRoutes);
app.route('/', briefRoutes);
app.route('/', copilotRoutes);
app.route('/', episodeRoutes);
app.route('/', ideaRoutes);

app.onError(() => new Response(JSON.stringify({ error: 'internal_error' }), {
	status: 500,
	headers: { 'content-type': 'application/json' },
}));

export default app;

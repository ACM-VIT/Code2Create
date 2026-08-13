import {
	instrument,
	setProvider,
} from '@flue/runtime';
import { createCloudflareTracing } from '@flue/runtime/cloudflare';
import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import { createAutonomyInstrumentation } from './lib/autonomyInstrumentation.ts';
import { createIntelligenceWorkersAiProvider } from './lib/workersAi.ts';
import { autonomyRoutes } from './routes/autonomyRoutes.ts';
import { briefRoutes } from './routes/briefRoutes.ts';
import { copilotRoutes } from './routes/copilotRoutes.ts';
import { healthRoutes } from './routes/healthRoutes.ts';
import { streamRoutes } from './routes/streamRoutes.ts';

instrument(createCloudflareTracing({ content: false }));
instrument(createAutonomyInstrumentation(env));
setProvider(createIntelligenceWorkersAiProvider(env.AI));

const app = new Hono<{ Bindings: Cloudflare.Env }>();

app.route('/', healthRoutes);
app.route('/', streamRoutes);
app.route('/', autonomyRoutes);
app.route('/', briefRoutes);
app.route('/', copilotRoutes);

app.onError(() => new Response(JSON.stringify({ error: 'internal_error' }), {
	status: 500,
	headers: { 'content-type': 'application/json' },
}));

export default app;

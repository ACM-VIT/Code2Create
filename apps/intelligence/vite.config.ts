import { cloudflare } from '@cloudflare/vite-plugin';
import { flue, flueWorkerConfig } from '@flue/vite';
import { defineConfig } from 'vite';

import { localIntelligenceWorkerEnvironment } from '../../scripts/local-development.mjs';

export default defineConfig(({ command }) => {
	const fluePlugin = flue();
	const configureFlueWorker = flueWorkerConfig();

	return {
		// Stream routes enforce one exact Operations origin. Let the Worker answer
		// preflights so local tunnel traffic exercises the production CORS boundary.
		server: { cors: false },
		// The virtual Worker entry is absent from Vite's initial dependency scan.
		// Pre-bundle Worker dependencies so workerd never imports renamed stale chunks.
		environments: {
			code2create_intelligence: {
				build: {
					minify: true,
				},
				optimizeDeps: {
					include: [
						'@flue/runtime',
						'@flue/runtime/cloudflare',
						'@flue/runtime/cloudflare/internal',
						'@flue/runtime/internal',
						'@earendil-works/pi-ai/providers/openai',
						'hono',
						'valibot',
					],
				},
			},
		},
		plugins: [
			fluePlugin,
			cloudflare({
				config(config) {
					configureFlueWorker(config);
					if (command !== 'serve') return;
					return {
						vars: {
							...config.vars,
							...localIntelligenceWorkerEnvironment,
						},
					};
				},
				inspectorPort: 9238,
			}),
		],
	};
});

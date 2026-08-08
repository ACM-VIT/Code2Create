import { cloudflare } from '@cloudflare/vite-plugin';
import { flue, flueWorkerConfig } from '@flue/vite';
import { defineConfig } from 'vite';

import { localIntelligenceWorkerEnvironment } from '../../scripts/local-development.mjs';

export default defineConfig(({ command }) => {
	const fluePlugin = flue();
	const configureFlueWorker = flueWorkerConfig();

	return {
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

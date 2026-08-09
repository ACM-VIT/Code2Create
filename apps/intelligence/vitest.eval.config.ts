import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// The live evaluation runs the real model, so it reads the same
// repository-root development credential the rest of the workspace uses.
const developmentEnvFile = fileURLToPath(new URL('../../.env.local', import.meta.url));
if (existsSync(developmentEnvFile)) process.loadEnvFile(developmentEnvFile);

if ((process.env['OPENAI_API_KEY'] ?? '').trim() === '') {
	console.warn(
		'\n[eval] Skipping the operations brief evaluation: it runs the live model and needs OPENAI_API_KEY, either in the environment or in the repository-root .env.local.\n',
	);
}

export default defineConfig({
	resolve: {
		alias: {
			// The agent reads its callback bindings from the Worker module, which
			// only exists inside workerd. Outside it, the evaluation supplies them.
			'cloudflare:workers': fileURLToPath(new URL('./src/evals/worker-env.ts', import.meta.url)),
		},
	},
	test: {
		include: ['src/evals/**/*.eval.ts'],
		testTimeout: 300_000,
		hookTimeout: 60_000,
		fileParallelism: false,
	},
});

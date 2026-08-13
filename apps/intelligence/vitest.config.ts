import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	resolve: {
		alias: [
			{
				find: /^@flue\/runtime\/cloudflare\/workers-ai$/u,
				replacement: fileURLToPath(
					new URL(
						'./node_modules/@flue/runtime/dist/cloudflare/workers-ai-provider.mjs',
						import.meta.url,
					),
				),
			},
			{
				find: /^@flue\/runtime\/cloudflare$/u,
				replacement: fileURLToPath(
					new URL('./src/evals/cloudflare-runtime.ts', import.meta.url),
				),
			},
			{
				find: 'cloudflare:workers',
				replacement: fileURLToPath(new URL('./src/evals/worker-env.ts', import.meta.url)),
			},
			{
				find: /^\.\.\/lib\/autonomyCloudflareArtifacts\.ts$/u,
				replacement: fileURLToPath(
					new URL('./src/evals/autonomy-artifacts.ts', import.meta.url),
				),
			},
		],
	},
	test: {
		include: [
			'src/**/*.test.ts',
			'src/evals/operations-autonomy.eval.ts',
			'src/evals/operations-autonomy-runtime.eval.ts',
		],
		testTimeout: 300_000,
		hookTimeout: 60_000,
		fileParallelism: false,
	},
});

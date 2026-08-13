import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Load the repository model credential for live evaluations.
const developmentEnvFile = fileURLToPath(new URL('../../.env.local', import.meta.url));
if (existsSync(developmentEnvFile)) process.loadEnvFile(developmentEnvFile);

if (!['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN'].every(
	(name) => (process.env[name] ?? '').trim().length > 0,
)) {
	console.warn(
		'\n[eval] Skipping only the live operations brief evaluation: it needs CLOUDFLARE_ACCOUNT_ID plus CLOUDFLARE_API_TOKEN in the environment or repository-root .env.local. Deterministic autonomy evaluations still run.\n',
	);
}

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
				// Replace workerd bindings with evaluation stand-ins.
				find: 'cloudflare:workers',
				replacement: fileURLToPath(new URL('./src/evals/worker-env.ts', import.meta.url)),
			},
			{
				// Keep production artifact semantics while replacing workerd-only SQL storage.
				find: /^\.\.\/lib\/autonomyCloudflareArtifacts\.ts$/u,
				replacement: fileURLToPath(
					new URL('./src/evals/autonomy-artifacts.ts', import.meta.url),
				),
			},
		],
	},
	test: {
		include: ['src/evals/**/*.eval.ts'],
		testTimeout: 300_000,
		hookTimeout: 60_000,
		fileParallelism: false,
	},
});

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { loadEnvFile } from 'node:process'
import { fileURLToPath } from 'node:url'

const backendEnvironmentPath = fileURLToPath(
  new URL('../apps/backend/.env.local', import.meta.url),
)
if (existsSync(backendEnvironmentPath)) loadEnvFile(backendEnvironmentPath)

const { localConvexEnvironment } = await import('./local-development.mjs')

const backend = ['--filter', '@code2create/backend', 'exec', 'convex']
const environmentInput = `${Object.entries(localConvexEnvironment)
  .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
  .join('\n')}\n`
const result = spawnSync(
  'pnpm',
  [...backend, 'env', 'set', '--force'],
  { input: environmentInput, encoding: 'utf8' },
)
process.stdout.write(result.stdout)
if (result.status !== 0) {
  process.stderr.write(result.stderr)
  process.exit(result.status ?? 1)
}

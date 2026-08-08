import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { loadEnvFile } from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const backendEnvironmentPath = fileURLToPath(
  new URL('../apps/backend/.env.local', import.meta.url),
)
if (existsSync(backendEnvironmentPath)) loadEnvFile(backendEnvironmentPath)

const { localConvexEnvironment } = await import('./local-development.mjs')

const backend = ['--filter', '@code2create/backend', 'exec', 'convex']
const environmentCommands = Object.entries(localConvexEnvironment).map(([key, value]) => [
  ...backend,
  'env',
  'set',
  key,
  value,
])

for (const args of environmentCommands) {
  const result = spawnSync('pnpm', args, { stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

let waitingForFunctions = false

async function runBackendFunction(functionName, functionArgs) {
  const args = [...backend, 'run', functionName, JSON.stringify(functionArgs)]
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const result = spawnSync('pnpm', args, { encoding: 'utf8' })
    if (result.status === 0) {
      process.stdout.write(result.stdout)
      return
    }
    const output = `${result.stdout}${result.stderr}`
    const functionsAreStarting =
      output.includes('Could not find function for') || output.includes('No functions found')
    if (!functionsAreStarting || attempt === 119) {
      process.stderr.write(output)
      process.exit(result.status ?? 1)
    }
    if (!waitingForFunctions) {
      waitingForFunctions = true
      process.stdout.write('Waiting for local Convex functions to finish starting…\n')
    }
    await delay(500)
  }
}

await runBackendFunction('localDevelopment:seedEvent', {
  confirmation: 'seed-code2create-local',
})
await runBackendFunction('localDemoSeed:seedDemoState', {
  confirmation: 'seed-code2create-demo',
})

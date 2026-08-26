import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { loadEnvFile } from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const backendEnvironmentPath = fileURLToPath(
  new URL('../apps/backend/.env.local', import.meta.url),
)
if (existsSync(backendEnvironmentPath)) loadEnvFile(backendEnvironmentPath)

const {
  localConvexEnvironment,
  localConvexEnvironmentRemovals,
} = await import('./local-development.mjs')

const mode = process.argv[2] ?? 'all'
if (!['all', 'environment', 'seed'].includes(mode)) {
  throw new Error(`Unknown local preparation mode: ${mode}`)
}

const backend = ['--filter', '@code2create/backend', 'exec', 'convex']

if (mode !== 'seed') {
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
  for (const key of localConvexEnvironmentRemovals) {
    const removal = spawnSync('pnpm', [...backend, 'env', 'remove', key], {
      encoding: 'utf8',
    })
    process.stdout.write(removal.stdout)
    if (removal.status !== 0) {
      process.stderr.write(removal.stderr)
      process.exit(removal.status ?? 1)
    }
  }
}

let waitingForFunctions = false

async function runBackendFunction(functionName, functionArgs, retryTransient = false) {
  const args = [...backend, 'run', functionName, JSON.stringify(functionArgs)]
  let transientRetries = 0
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const result = spawnSync('pnpm', args, { encoding: 'utf8' })
    if (result.status === 0) {
      process.stdout.write(result.stdout)
      return
    }
    const output = `${result.stdout}${result.stderr}`
    const functionsAreStarting =
      output.includes('Could not find function for') || output.includes('No functions found')
    const hitTransientLocalLimit = retryTransient && (
      output.includes('Function execution timed out') ||
      output.includes('Too many writes per second')
    )
    if (hitTransientLocalLimit) transientRetries += 1
    if (
      (!functionsAreStarting && (!hitTransientLocalLimit || transientRetries > 8)) ||
      attempt === 119
    ) {
      process.stderr.write(output)
      process.exit(result.status ?? 1)
    }
    if (functionsAreStarting && !waitingForFunctions) {
      waitingForFunctions = true
      process.stdout.write('Waiting for local Convex functions to finish starting…\n')
    }
    if (hitTransientLocalLimit) {
      process.stdout.write('Retrying the idempotent demo seed after a local runtime limit…\n')
    }
    await delay(hitTransientLocalLimit ? 1_000 : 500)
  }
}

if (mode !== 'environment') {
  await runBackendFunction('localDevelopment:seedEvent', {
    confirmation: 'seed-code2create-local',
  })
  await runBackendFunction('localDemoSeed:seedDemoState', {
    confirmation: 'seed-code2create-demo',
  }, true)
}

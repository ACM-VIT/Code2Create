import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

const workspace = new URL('..', import.meta.url)
const children = new Set()
let stopping = false

function start(args) {
  const child = spawn('pnpm', args, {
    cwd: workspace,
    env: process.env,
    stdio: 'inherit',
  })
  children.add(child)
  child.once('exit', () => children.delete(child))
  return child
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
}

async function waitForBackend(backendExit) {
  const ready = (async () => {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      try {
        const response = await fetch('http://127.0.0.1:3212/version')
        if (response.ok) return
      } catch {
        // The local backend has not opened its port yet.
      }
      await delay(250)
    }
    throw new Error('The local Convex backend did not become ready on port 3212.')
  })()
  const result = await Promise.race([
    ready.then(() => ({ ready: true })),
    backendExit.then((exit) => ({ ready: false, exit })),
  ])
  if (!result.ready) {
    throw new Error(
      `The backend stopped before it was ready (${result.exit.signal ?? `exit ${result.exit.code}`}).`,
    )
  }
}

async function runPreparation() {
  const child = start(['dev:prepare'])
  const { code, signal } = await waitForExit(child)
  if (code !== 0) {
    throw new Error(`Local preparation failed (${signal ?? `exit ${code}`}).`)
  }
}

function stop(signal = 'SIGTERM') {
  if (stopping) return
  stopping = true
  for (const child of children) child.kill(signal)
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => stop(signal))
}

try {
  const backend = start(['dev:backend'])
  const backendExit = waitForExit(backend)
  await waitForBackend(backendExit)
  await runPreparation()

  const applications = start([
    '--parallel',
    '--stream',
    '--filter',
    '@code2create/web',
    '--filter',
    '@code2create/ops',
    '--filter',
    '@code2create/handbook',
    '--filter',
    '@code2create/reviewer',
    '--filter',
    '@code2create/intelligence',
    '--filter',
    '@code2create/updates',
    '--filter',
    '@code2create/email',
    'run',
    'dev',
  ])
  const stopped = await Promise.race([
    backendExit.then((exit) => ({ application: 'backend', ...exit })),
    waitForExit(applications).then((exit) => ({ application: 'application', ...exit })),
  ])
  const unexpected = !stopping
  stop()
  if (unexpected) {
    throw new Error(
      `The local ${stopped.application} process stopped (${stopped.signal ?? `exit ${stopped.code}`}).`,
    )
  }
} catch (error) {
  stop()
  const message = error instanceof Error ? error.message : String(error)
  console.error(message)
  process.exitCode = 1
}

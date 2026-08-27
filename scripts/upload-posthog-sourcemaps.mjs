import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const directoryArgument = process.argv[2]
const releaseName = process.argv[3]
const releaseVersion = process.env.VITE_RELEASE_ID?.trim()

if (!directoryArgument || !releaseName) {
  throw new Error('Pass the build directory and PostHog release name.')
}
if (!releaseVersion) throw new Error('Set VITE_RELEASE_ID before uploading PostHog source maps.')

const directory = resolve(directoryArgument)
run(['sourcemap', 'inject', '--directory', directory])
run([
  'sourcemap',
  'upload',
  '--directory',
  directory,
  '--release-name',
  releaseName,
  '--release-version',
  releaseVersion,
  '--skip-on-conflict',
  '--delete-after',
])

function run(arguments_) {
  const result = spawnSync('pnpm', ['exec', 'posthog-cli', ...arguments_], {
    env: process.env,
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`posthog-cli failed with exit code ${result.status ?? 'unknown'}.`)
  }
}

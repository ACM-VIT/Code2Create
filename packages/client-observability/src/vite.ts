import { sentryVitePlugin } from '@sentry/vite-plugin'

import {
  parseDeploymentEnvironment,
  requiredTelemetryRelease,
  validateTelemetryDsn,
} from './environment.ts'

type BuildEnvironment = Readonly<Record<string, string | undefined>>

export function sentryViteBuild(environment: BuildEnvironment) {
  const dsn = normalized(environment.VITE_SENTRY_DSN)
  if (!dsn) return { plugins: [], sourcemap: false as const }
  validateTelemetryDsn(dsn)

  const deploymentEnvironment = parseDeploymentEnvironment(
    normalized(environment.VITE_DEPLOYMENT_ENVIRONMENT),
  )
  const release = requiredTelemetryRelease(environment.VITE_RELEASE_ID, 'VITE_RELEASE_ID')
  const authToken = normalized(environment.SENTRY_AUTH_TOKEN)
  const organization = normalized(environment.SENTRY_ORG)
  const project = normalized(environment.SENTRY_PROJECT)
  if (!authToken || !organization || !project) {
    if (deploymentEnvironment !== 'development') {
      throw new Error(
        'Staging and production Sentry builds require SENTRY_AUTH_TOKEN, SENTRY_ORG, and SENTRY_PROJECT.',
      )
    }
    return { plugins: [], sourcemap: false as const }
  }

  return {
    sourcemap: 'hidden' as const,
    plugins: [
      sentryVitePlugin({
        authToken,
        org: organization,
        project,
        release: { name: release },
        sourcemaps: { filesToDeleteAfterUpload: './dist/**/*.map' },
        telemetry: false,
      }),
    ],
  }
}

function normalized(value: string | undefined) {
  const result = value?.trim()
  return result ? result : undefined
}

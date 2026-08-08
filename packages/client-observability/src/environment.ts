export type DeploymentEnvironment = 'development' | 'staging' | 'production'

export function parseDeploymentEnvironment(value: string | undefined): DeploymentEnvironment {
  if (value === 'development' || value === 'staging' || value === 'production') return value
  throw new Error('Set the deployment environment to development, staging, or production.')
}

export function requiredTelemetryRelease(value: string | undefined, variableName: string) {
  const release = value?.trim()
  if (!release || release.length > 120) {
    throw new Error(`Set a non-empty ${variableName} no longer than 120 characters when Sentry is enabled.`)
  }
  return release
}

export function validateTelemetryDsn(value: string) {
  const dsn = new URL(value)
  if (dsn.protocol !== 'https:' || !dsn.username || dsn.pathname === '/') {
    throw new Error('The Sentry DSN must be a complete HTTPS project DSN.')
  }
}

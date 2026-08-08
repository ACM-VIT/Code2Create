type ReleaseSurface = 'participant' | 'operations' | 'handbook'
type ValidationMode = 'build' | 'deploy'
type BuildEnvironment = Readonly<Record<string, string | undefined>>

export function validateWebReleaseEnvironment(
  surface: ReleaseSurface,
  mode: ValidationMode,
  environment: BuildEnvironment,
) {
  const cloudflareEnvironment = requiredCloudflareEnvironment(environment)
  const releaseId = required(environment, 'VITE_RELEASE_ID')
  if (releaseId.length > 120) {
    throw new Error('VITE_RELEASE_ID must be no longer than 120 characters.')
  }

  if (mode === 'deploy') return

  const deploymentEnvironment = required(environment, 'VITE_DEPLOYMENT_ENVIRONMENT')
  if (deploymentEnvironment !== cloudflareEnvironment) {
    throw new Error('VITE_DEPLOYMENT_ENVIRONMENT must match CLOUDFLARE_ENV.')
  }

  requiredHttpsUrl(environment, 'VITE_CONVEX_URL')
  requiredHttpsUrl(environment, 'VITE_CONVEX_SITE_URL')

  const eventSlug = required(environment, 'VITE_EVENT_SLUG')
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(eventSlug) || eventSlug.length > 80) {
    throw new Error('VITE_EVENT_SLUG must be a lowercase hyphenated slug of at most 80 characters.')
  }

  if (surface === 'handbook') return

  const dsn = requiredHttpsUrl(environment, 'VITE_SENTRY_DSN', true)
  if (!dsn.username || dsn.pathname === '/') {
    throw new Error('VITE_SENTRY_DSN must be a complete HTTPS project DSN.')
  }
  required(environment, 'SENTRY_ORG')
  required(environment, 'SENTRY_PROJECT')
  required(environment, 'SENTRY_AUTH_TOKEN')
}

function requiredCloudflareEnvironment(environment: BuildEnvironment) {
  const value = required(environment, 'CLOUDFLARE_ENV')
  if (value !== 'staging' && value !== 'production') {
    throw new Error('CLOUDFLARE_ENV must be staging or production.')
  }
  return value
}

function requiredHttpsUrl(
  environment: BuildEnvironment,
  name: string,
  allowPublicUsername = false,
) {
  const value = required(environment, name)
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${name} must be a complete HTTPS URL.`)
  }
  if (url.protocol !== 'https:' || url.password || (!allowPublicUsername && url.username)) {
    throw new Error(`${name} must be a complete HTTPS URL without embedded credentials.`)
  }
  return url
}

function required(environment: BuildEnvironment, name: string) {
  const value = environment[name]?.trim()
  if (!value) throw new Error(`Set ${name} for this release environment.`)
  return value
}

function parseSurface(value: string | undefined): ReleaseSurface {
  if (value === 'participant' || value === 'operations' || value === 'handbook') return value
  throw new Error('Choose the participant, operations, or handbook release surface.')
}

function parseMode(value: string | undefined): ValidationMode {
  if (value === 'build' || value === 'deploy') return value
  throw new Error('Choose build or deploy validation.')
}

if (import.meta.main) {
  const surface = parseSurface(process.argv[2])
  const mode = parseMode(process.argv[3])
  validateWebReleaseEnvironment(surface, mode, process.env)
  console.log(`${surface} ${mode} environment is valid for ${process.env.CLOUDFLARE_ENV}.`)
}

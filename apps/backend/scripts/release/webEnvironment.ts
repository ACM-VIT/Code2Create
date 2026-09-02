type ReleaseSurface = 'landing' | 'participant' | 'operations'
type ValidationMode = 'build' | 'deploy'
type BuildEnvironment = Readonly<Record<string, string | undefined>>

const convexOrigins = {
  staging: {
    cloud: 'https://realtime-staging.c2c.sh',
    site: 'https://api-staging.c2c.sh',
  },
  production: {
    cloud: 'https://realtime.c2c.sh',
    site: 'https://api.c2c.sh',
  },
} as const

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

  const deploymentEnvironment = required(environment, 'VITE_DEPLOYMENT_ENVIRONMENT')
  if (deploymentEnvironment !== cloudflareEnvironment) {
    throw new Error('VITE_DEPLOYMENT_ENVIRONMENT must match CLOUDFLARE_ENV.')
  }

  if (surface !== 'landing') {
    const convexUrl = requiredHttpsOrigin(environment, 'VITE_CONVEX_URL')
    const convexSiteUrl = requiredHttpsOrigin(environment, 'VITE_CONVEX_SITE_URL')
    const expectedOrigins = convexOrigins[cloudflareEnvironment]
    if (convexUrl !== expectedOrigins.cloud) {
      throw new Error(`VITE_CONVEX_URL must be ${expectedOrigins.cloud} for ${cloudflareEnvironment}.`)
    }
    if (convexSiteUrl !== expectedOrigins.site) {
      throw new Error(
        `VITE_CONVEX_SITE_URL must be ${expectedOrigins.site} for ${cloudflareEnvironment}.`,
      )
    }

    const eventSlug = required(environment, 'VITE_EVENT_SLUG')
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(eventSlug) || eventSlug.length > 80) {
      throw new Error('VITE_EVENT_SLUG must be a lowercase hyphenated slug of at most 80 characters.')
    }
  }

  const projectToken = required(environment, 'VITE_POSTHOG_PROJECT_TOKEN')
  if (!/^phc_[A-Za-z0-9]+$/u.test(projectToken)) {
    throw new Error('VITE_POSTHOG_PROJECT_TOKEN must be a PostHog project token.')
  }
  requiredHttpsUrl(environment, 'VITE_POSTHOG_HOST')

  if (mode === 'deploy') return

  requiredHttpsUrl(environment, 'POSTHOG_CLI_HOST')
  const projectId = required(environment, 'POSTHOG_CLI_PROJECT_ID')
  if (!/^\d+$/u.test(projectId) || Number(projectId) < 1) {
    throw new Error('POSTHOG_CLI_PROJECT_ID must be a positive integer.')
  }
  required(environment, 'POSTHOG_CLI_API_KEY')
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
) {
  const value = required(environment, name)
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${name} must be a complete HTTPS URL.`)
  }
  if (url.protocol !== 'https:' || url.password || url.username) {
    throw new Error(`${name} must be a complete HTTPS URL without embedded credentials.`)
  }
  return url
}

function requiredHttpsOrigin(environment: BuildEnvironment, name: string) {
  const value = requiredHttpsUrl(environment, name)
  if (value.pathname !== '/' || value.search || value.hash) {
    throw new Error(`${name} must be one HTTPS origin without a path.`)
  }
  return value.origin
}

function required(environment: BuildEnvironment, name: string) {
  const value = environment[name]?.trim()
  if (!value) throw new Error(`Set ${name} for this release environment.`)
  return value
}

function parseSurface(value: string | undefined): ReleaseSurface {
  if (value === 'landing' || value === 'participant' || value === 'operations') return value
  throw new Error('Choose the landing, participant, or operations release surface.')
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

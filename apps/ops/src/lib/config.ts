export const eventSlug = import.meta.env.VITE_EVENT_SLUG || 'code2create-7'

export const clientConfiguration = {
  convexUrl: import.meta.env.VITE_CONVEX_URL,
  convexSiteUrl: import.meta.env.VITE_CONVEX_SITE_URL,
  sentryDsn: import.meta.env.VITE_SENTRY_DSN,
  deploymentEnvironment: import.meta.env.VITE_DEPLOYMENT_ENVIRONMENT,
  releaseId: import.meta.env.VITE_RELEASE_ID,
}

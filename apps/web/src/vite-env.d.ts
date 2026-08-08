interface ViteTypeOptions {
  strictImportMetaEnv: unknown
}

interface ImportMetaEnv {
  readonly VITE_CONVEX_SITE_URL?: string
  readonly VITE_CONVEX_URL?: string
  readonly VITE_DEPLOYMENT_ENVIRONMENT?: string
  readonly VITE_EVENT_SLUG?: string
  readonly VITE_RELEASE_ID?: string
  readonly VITE_SENTRY_DSN?: string
}

export const eventSlug = import.meta.env.VITE_EVENT_SLUG || "code2create-7";

export const clientConfiguration = {
  convexUrl: import.meta.env.VITE_CONVEX_URL,
  convexSiteUrl: import.meta.env.VITE_CONVEX_SITE_URL,
  posthogProjectToken: import.meta.env.VITE_POSTHOG_PROJECT_TOKEN,
  posthogHost: import.meta.env.VITE_POSTHOG_HOST,
  deploymentEnvironment: import.meta.env.VITE_DEPLOYMENT_ENVIRONMENT,
  releaseId: import.meta.env.VITE_RELEASE_ID,
};

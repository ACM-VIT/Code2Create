export const participantPortalUrl =
  import.meta.env.VITE_PARTICIPANT_PORTAL_URL || 'http://localhost:5180';

export const clientConfiguration = {
  posthogProjectToken: import.meta.env.VITE_POSTHOG_PROJECT_TOKEN,
  posthogHost: import.meta.env.VITE_POSTHOG_HOST,
  deploymentEnvironment: import.meta.env.VITE_DEPLOYMENT_ENVIRONMENT,
  releaseId: import.meta.env.VITE_RELEASE_ID,
};

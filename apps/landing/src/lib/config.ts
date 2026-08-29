export const eventRegistrationUrl =
  import.meta.env.VITE_EVENT_REGISTRATION_URL ||
  'https://gravitas.vit.ac.in/events/0eba5a6f-2687-416c-acd7-c51419433366';

export const clientConfiguration = {
  posthogProjectToken: import.meta.env.VITE_POSTHOG_PROJECT_TOKEN,
  posthogHost: import.meta.env.VITE_POSTHOG_HOST,
  deploymentEnvironment: import.meta.env.VITE_DEPLOYMENT_ENVIRONMENT,
  releaseId: import.meta.env.VITE_RELEASE_ID,
};

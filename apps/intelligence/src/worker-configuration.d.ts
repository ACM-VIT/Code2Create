declare namespace Cloudflare {
	interface Env {
		INTELLIGENCE_INGRESS_SECRET: string;
		INTELLIGENCE_CALLBACK_SECRET: string;
		// A separate secret for the read direction: the callback secret proves
		// "the Worker finished a brief", the read secret proves "the Worker may
		// ask for a redacted projection" — revocable independently.
		INTELLIGENCE_READ_SECRET: string;
		CONVEX_INTELLIGENCE_CALLBACK_URL: string;
		CONVEX_INTELLIGENCE_READ_URL: string;
		CONVEX_INTELLIGENCE_RECOMMENDATION_URL: string;
		// Read by the model provider through `process.env` (nodejs_compat),
		// never by application code.
		OPENAI_API_KEY: string;
	}
}

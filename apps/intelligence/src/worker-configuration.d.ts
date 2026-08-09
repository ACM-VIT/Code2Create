declare namespace Cloudflare {
	interface Env {
		INTELLIGENCE_INGRESS_SECRET: string;
		INTELLIGENCE_CALLBACK_SECRET: string;
		CONVEX_INTELLIGENCE_CALLBACK_URL: string;
		// Read by the model provider through `process.env` (nodejs_compat),
		// never by application code.
		OPENAI_API_KEY: string;
	}
}

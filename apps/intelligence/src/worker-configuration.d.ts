declare namespace Cloudflare {
	interface Env {
		OPENAI_API_KEY: string;
		FLUE_OPERATIONS_AUTOPILOT_AGENT: {
			getByName(runId: string): {
				requestAutonomyArtifactPurge(): Promise<void>;
			};
		};
		OPERATIONS_AUTONOMY_ADMISSION_FENCE:
			import('./lib/autonomyAdmissionController.ts').AutonomyAdmissionControllerNamespace;
		INTELLIGENCE_INGRESS_SECRET: string;
		INTELLIGENCE_CALLBACK_SECRET: string;
		INTELLIGENCE_STREAM_SECRET: string;
		// Separate from callback signing so read access can be revoked independently.
		INTELLIGENCE_READ_SECRET: string;
		CONVEX_INTELLIGENCE_CALLBACK_URL: string;
		CONVEX_INTELLIGENCE_READ_URL: string;
		CONVEX_INTELLIGENCE_RECOMMENDATION_URL: string;
		CONVEX_INTELLIGENCE_EPISODE_READ_URL: string;
		CONVEX_INTELLIGENCE_EPISODE_CALLBACK_URL: string;
		CONVEX_INTELLIGENCE_AUTONOMY_CALLBACK_URL: string;
		CONVEX_INTELLIGENCE_AUTONOMY_READ_URL: string;
		CONVEX_INTELLIGENCE_AUTONOMY_WORK_URL: string;
		CONVEX_INTELLIGENCE_AUTONOMY_RECOMMENDATION_URL: string;
		CONVEX_INTELLIGENCE_AUTONOMY_RECOMMENDATION_EVIDENCE_URL: string;
		OPS_ORIGIN: string;
	}
}

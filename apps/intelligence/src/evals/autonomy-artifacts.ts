import { memoryAutonomyArtifactStore } from "../lib/autonomyArtifacts.ts";

const evaluationArtifacts = memoryAutonomyArtifactStore();

/**
 * Node evaluations exercise the production orchestration against the same
 * artifact-store contract. Only the Cloudflare Durable Object SQL adapter is
 * replaced because no workerd storage context exists in the Node Flue runtime.
 */
export function cloudflareAutonomyArtifactStore() {
  return evaluationArtifacts;
}

export function resetAutonomyEvaluationArtifacts() {
  return evaluationArtifacts.clearRunArtifacts();
}

export function purgeCloudflareAutonomyArtifacts() {
  // Node evaluations have no workerd SQL owner. The singleton store is reset
  // explicitly by the evaluation lifecycle instead.
}

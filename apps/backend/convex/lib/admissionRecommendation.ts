import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { admissionWorkpool } from "../workpools";
import { admissionInputFingerprint } from "./admission";
import { appendAdmissionJobReadFactById } from "./operationsAutonomyReadFacts/admissionJobs";

export async function createAdmissionRecommendation(
  ctx: MutationCtx,
  args: {
    application: Doc<"applications">;
    project: Doc<"projectVersions">;
    policy: Doc<"admissionPolicyVersions">;
    modelConfig: Doc<"admissionModelConfigVersions"> | null;
    now: number;
  },
): Promise<Id<"admissionAIRecommendations">> {
  if (
    args.project.eventId !== args.application.eventId ||
    args.project.teamId !== args.application.teamId ||
    args.project._id !== args.application.submittedProjectVersionId ||
    args.policy.eventId !== args.application.eventId ||
    args.policy._id !== args.application.admissionPolicyVersionId ||
    (args.modelConfig !== null &&
      (args.modelConfig.eventId !== args.application.eventId ||
        args.modelConfig.admissionPolicyVersionId !== args.policy._id))
  ) {
    throw new Error("Admission recommendation context does not match the application.");
  }
  const sourceInputFingerprint = admissionInputFingerprint({
    applicationVersion: args.application.contentVersion,
    projectVersionId: args.project._id,
    projectVersion: args.project.version,
    initialIdea: args.project.initialIdea,
    ...(args.project.additionalInformation !== undefined
      ? { additionalInformation: args.project.additionalInformation }
      : {}),
    intakeResponses: args.project.intakeResponses,
    experienceBand: args.application.experienceBand,
    admissionPolicyVersionId: args.policy._id,
    admissionPolicyChecksum: args.policy.checksum,
    ...(args.modelConfig
      ? {
          modelConfigVersionId: args.modelConfig._id,
          modelConfigChecksum: args.modelConfig.checksum,
        }
      : {}),
  });
  const recommendationId = await ctx.db.insert("admissionAIRecommendations", {
    eventId: args.application.eventId,
    applicationId: args.application._id,
    teamId: args.application.teamId,
    projectVersionId: args.project._id,
    admissionPolicyVersionId: args.policy._id,
    ...(args.modelConfig ? { modelConfigVersionId: args.modelConfig._id } : {}),
    applicationContentVersion: args.application.contentVersion,
    sourceInputFingerprint,
    experienceBand: args.application.experienceBand,
    state: args.modelConfig ? "pending" : "disabled",
    criterionAssessments: [],
    strengths: [],
    concerns: [],
    limitations: args.modelConfig
      ? []
      : ["No published admission model is configured; human review remains required."],
    ...(!args.modelConfig
      ? { failureCategory: "model_not_configured", completedAt: args.now }
      : {}),
    createdAt: args.now,
  });
  await appendAdmissionJobReadFactById(ctx, recommendationId, args.now);
  await ctx.db.patch(args.application._id, {
    aiRecommendationId: recommendationId,
    aiDisposition: args.modelConfig ? undefined : "unavailable",
  });
  if (args.modelConfig) {
    await admissionWorkpool.enqueueAction(
      ctx,
      internal.admissionAgentActions.dispatchRecommendation,
      { recommendationId },
      {
        retry: true,
        onComplete: internal.admissionIntelligence.agentDispatchFinished,
        context: recommendationId,
      },
    );
  }
  return recommendationId;
}

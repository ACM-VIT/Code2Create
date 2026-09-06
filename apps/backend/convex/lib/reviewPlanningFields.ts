import { v } from "convex/values";

const finding = v.object({ text: v.string(), sourceIds: v.array(v.string()) });
export const projectReviewAssessment = v.object({
  examinedSourceIds: v.array(v.string()),
  title: v.string(),
  summary: finding,
  users: finding,
  minimumDeliverable: finding,
  architecture: finding,
  implementationEvidence: finding,
  primaryPool: v.string(),
  secondaryPools: v.array(v.string()),
  specialistSkills: v.array(v.string()),
  panelFitReason: v.string(),
  risksToProbe: v.array(finding),
  suggestedQuestions: v.array(
    v.object({
      criterionKey: v.string(),
      question: v.string(),
      why: v.string(),
      sourceIds: v.array(v.string()),
    }),
  ),
  limitations: v.array(v.string()),
});

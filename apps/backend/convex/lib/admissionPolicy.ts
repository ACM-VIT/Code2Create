import { ConvexError, v } from "convex/values";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { admissionDecision } from "../values";
import { loadPublishedParticipantPolicy } from "./participantPolicy";
import { admissionRecommendationModel } from "./ideaSubmissionAi";
import { fingerprintText, normalizedLongText, normalizedText } from "./strings";

type ReadCtx = QueryCtx | MutationCtx;
type AdmissionDecision = NonNullable<Doc<"applications">["humanDecision"]>;

const allAdmissionDecisions: AdmissionDecision[] = [
  "accept",
  "waitlist",
  "decline",
];

export const admissionGuidanceInput = v.object({
  firstYear: v.string(),
  earlyYear: v.string(),
  laterYear: v.string(),
  postgraduateOrProfessional: v.string(),
  mixedOrExternal: v.string(),
});

export const admissionCriterionInput = v.object({
  criterionKey: v.string(),
  label: v.string(),
  guidanceByBand: admissionGuidanceInput,
});

export const admissionReasonCodeInput = v.object({
  key: v.string(),
  label: v.string(),
  allowedDecisions: v.array(admissionDecision),
});

export const admissionModelConfigurationInput = v.object({
  version: v.string(),
  modelId: v.string(),
  promptVersion: v.string(),
  schemaVersion: v.string(),
  evaluationSuiteVersion: v.string(),
});

export const admissionConfigurationInput = v.object({
  version: v.string(),
  minimumHumanReviews: v.number(),
  overallParticipantCapacity: v.number(),
  criteria: v.array(admissionCriterionInput),
  decisionReasonCodes: v.array(admissionReasonCodeInput),
  model: v.union(v.null(), admissionModelConfigurationInput),
});

export type AdmissionGuidance = {
  firstYear: string;
  earlyYear: string;
  laterYear: string;
  postgraduateOrProfessional: string;
  mixedOrExternal: string;
};

export type AdmissionCriterion = {
  criterionKey: string;
  label: string;
  guidanceByBand: AdmissionGuidance;
};

export type AdmissionReasonCode = {
  key: string;
  label: string;
  allowedDecisions: AdmissionDecision[];
};

export type AdmissionModelConfiguration = {
  version: string;
  modelId: string;
  promptVersion: string;
  schemaVersion: string;
  evaluationSuiteVersion: string;
};

export type AdmissionConfiguration = {
  version: string;
  minimumHumanReviews: number;
  overallParticipantCapacity: number;
  criteria: AdmissionCriterion[];
  decisionReasonCodes: AdmissionReasonCode[];
  model: AdmissionModelConfiguration | null;
};

export const defaultAdmissionCriteria: AdmissionCriterion[] = [
  {
    criterionKey: "problem_clarity",
    label: "Problem clarity",
    guidanceByBand: {
      firstYear: "The team identifies a real problem and who experiences it, even in simple terms.",
      earlyYear:
        "The team identifies a real problem, intended users, and the useful change it wants to create.",
      laterYear:
        "The problem, users, constraints, and intended outcome are specific enough to guide a build.",
      postgraduateOrProfessional:
        "The problem framing is precise, bounded, and grounded in a credible user or operational need.",
      mixedOrExternal:
        "The problem and intended users are clear, with expectations applied to the experience the team describes rather than institution or prestige.",
    },
  },
  {
    criterionKey: "genuine_intent",
    label: "Genuine intent",
    guidanceByBand: {
      firstYear:
        "The response shows genuine interest and a plausible reason the team wants to work on it.",
      earlyYear:
        "The response shows genuine intent and a basic understanding of why the project would matter.",
      laterYear:
        "The team demonstrates ownership of the problem and a considered reason for its approach.",
      postgraduateOrProfessional:
        "The team demonstrates clear ownership, relevant reflection, and a credible reason to pursue this approach.",
      mixedOrExternal:
        "The team demonstrates genuine ownership without relying on credentials, affiliations, or past outcomes.",
    },
  },
  {
    criterionKey: "feasibility",
    label: "Hackathon feasibility",
    guidanceByBand: {
      firstYear:
        "A workable basic idea and a small end-of-event outcome are enough; implementation detail may be light.",
      earlyYear: "The team describes a plausible core flow that can be attempted during the event.",
      laterYear:
        "The intended scope, core flow, and likely implementation path fit the event window.",
      postgraduateOrProfessional:
        "The scope, dependencies, risks, and event-sized deliverable form a credible execution plan.",
      mixedOrExternal:
        "The team proposes a credible event-sized outcome, interpreted in light of the experience it declares.",
    },
  },
  {
    criterionKey: "detail_and_differentiation",
    label: "Detail and differentiation",
    guidanceByBand: {
      firstYear:
        "A simple explanation of what someone can do is sufficient; novelty and deep technical detail are not required.",
      earlyYear:
        "The core interaction is understandable and the team reflects on how the project will be useful.",
      laterYear:
        "The technical direction and meaningful distinction from common versions of the idea are reasonably clear.",
      postgraduateOrProfessional:
        "The proposal gives a concrete technical direction, acknowledges common alternatives, and states a defensible distinction.",
      mixedOrExternal:
        "The core interaction and useful distinction are clear for the team’s stated context.",
    },
  },
];

export const defaultAdmissionReasonCodes: AdmissionReasonCode[] = [
  {
    key: "clear_and_workable",
    label: "Clear and workable for this experience band",
    allowedDecisions: ["accept"],
  },
  {
    key: "promising_with_capacity_limit",
    label: "Promising application; capacity is limited",
    allowedDecisions: ["waitlist"],
  },
  {
    key: "scope_not_yet_workable",
    label: "The proposed event scope is not yet workable",
    allowedDecisions: ["waitlist", "decline"],
  },
  {
    key: "application_not_yet_clear",
    label: "The application is not yet clear enough for this experience band",
    allowedDecisions: ["waitlist", "decline"],
  },
];

export type AdmissionPolicy = Omit<AdmissionConfiguration, "model"> & {
  aiRecommendationMode: "enabled" | "disabled";
};

function invalidPolicy(message: string): never {
  throw new ConvexError({ code: "INVALID_ADMISSION_POLICY", message });
}

function wholeNumber(value: number, label: string, minimum: number, maximum: number) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    invalidPolicy(`${label} must be a whole number from ${minimum} through ${maximum}.`);
  }
  return value;
}

function positiveWholeNumber(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 1) {
    invalidPolicy(`${label} must be a positive whole number.`);
  }
  return value;
}

function stableKey(value: string, label: string) {
  const normalized = normalizedText(value, label, 2, 60).toLowerCase();
  if (!/^[a-z0-9]+(?:_[a-z0-9]+)*$/u.test(normalized)) {
    invalidPolicy(`${label} must use lowercase letters, numbers, and underscores.`);
  }
  return normalized;
}

function uniqueValues(values: readonly string[], label: string) {
  if (new Set(values).size !== values.length) {
    invalidPolicy(`${label} must be unique.`);
  }
}

function normalizeGuidance(guidance: AdmissionGuidance): AdmissionGuidance {
  return {
    firstYear: normalizedLongText(guidance.firstYear, "First-year guidance", 20, 600),
    earlyYear: normalizedLongText(guidance.earlyYear, "Early-year guidance", 20, 600),
    laterYear: normalizedLongText(guidance.laterYear, "Later-year guidance", 20, 600),
    postgraduateOrProfessional: normalizedLongText(
      guidance.postgraduateOrProfessional,
      "Postgraduate or professional guidance",
      20,
      600,
    ),
    mixedOrExternal: normalizedLongText(
      guidance.mixedOrExternal,
      "Mixed or external-team guidance",
      20,
      600,
    ),
  };
}

function normalizeModel(
  model: AdmissionModelConfiguration | null,
): AdmissionModelConfiguration | null {
  if (!model) return null;
  return {
    version: normalizedText(model.version, "Admission model release", 1, 80),
    modelId: normalizedText(model.modelId, "Admission model ID", 2, 120),
    promptVersion: normalizedText(model.promptVersion, "Prompt version", 1, 80),
    schemaVersion: normalizedText(model.schemaVersion, "Schema version", 1, 80),
    evaluationSuiteVersion: normalizedText(
      model.evaluationSuiteVersion,
      "Evaluation suite version",
      1,
      80,
    ),
  };
}

export function normalizeAdmissionConfiguration(
  input: AdmissionConfiguration,
): AdmissionConfiguration {
  if (input.criteria.length < 1 || input.criteria.length > 12) {
    invalidPolicy("Admission policy must contain one through twelve criteria.");
  }
  if (input.decisionReasonCodes.length < 4 || input.decisionReasonCodes.length > 20) {
    invalidPolicy("Admission policy must contain four through twenty decision reasons.");
  }
  const criteria = input.criteria.map((criterion) => ({
    criterionKey: stableKey(criterion.criterionKey, "Criterion key"),
    label: normalizedText(criterion.label, "Criterion label", 3, 100),
    guidanceByBand: normalizeGuidance(criterion.guidanceByBand),
  }));
  uniqueValues(
    criteria.map((criterion) => criterion.criterionKey),
    "Criterion keys",
  );
  const decisionReasonCodes = input.decisionReasonCodes.map((reason) => {
    if (reason.allowedDecisions.length < 1 || reason.allowedDecisions.length > 4) {
      invalidPolicy("Every decision reason must allow one through four decisions.");
    }
    uniqueValues(reason.allowedDecisions, "Allowed decisions on one reason");
    return {
      key: stableKey(reason.key, "Decision-reason key"),
      label: normalizedText(reason.label, "Decision-reason label", 5, 160),
      allowedDecisions: [...reason.allowedDecisions],
    };
  });
  uniqueValues(
    decisionReasonCodes.map((reason) => reason.key),
    "Decision-reason keys",
  );
  for (const decision of allAdmissionDecisions) {
    if (!decisionReasonCodes.some((reason) => reason.allowedDecisions.includes(decision))) {
      invalidPolicy(`At least one decision reason must permit ${decision}.`);
    }
  }
  return {
    version: normalizedText(input.version, "Admission policy release", 1, 80),
    minimumHumanReviews: wholeNumber(input.minimumHumanReviews, "Minimum human reviews", 1, 5),
    overallParticipantCapacity: positiveWholeNumber(
      input.overallParticipantCapacity,
      "Participant capacity",
    ),
    criteria,
    decisionReasonCodes,
    model: normalizeModel(input.model),
  };
}

export function admissionPolicyForConfiguration(
  configuration: AdmissionConfiguration,
): AdmissionPolicy {
  return {
    version: configuration.version,
    minimumHumanReviews: configuration.minimumHumanReviews,
    overallParticipantCapacity: configuration.overallParticipantCapacity,
    criteria: configuration.criteria,
    decisionReasonCodes: configuration.decisionReasonCodes,
    aiRecommendationMode: configuration.model ? "enabled" : "disabled",
  };
}

export function admissionPolicyChecksum(policy: AdmissionPolicy) {
  return fingerprintText(
    JSON.stringify({
      version: policy.version,
      aiRecommendationMode: policy.aiRecommendationMode,
      minimumHumanReviews: policy.minimumHumanReviews,
      overallParticipantCapacity: policy.overallParticipantCapacity,
      criteria: policy.criteria.map((criterion) => ({
        criterionKey: criterion.criterionKey,
        label: criterion.label,
        guidanceByBand: {
          firstYear: criterion.guidanceByBand.firstYear,
          earlyYear: criterion.guidanceByBand.earlyYear,
          laterYear: criterion.guidanceByBand.laterYear,
          postgraduateOrProfessional: criterion.guidanceByBand.postgraduateOrProfessional,
          mixedOrExternal: criterion.guidanceByBand.mixedOrExternal,
        },
      })),
      decisionReasonCodes: policy.decisionReasonCodes.map((reason) => ({
        key: reason.key,
        label: reason.label,
        allowedDecisions: reason.allowedDecisions,
      })),
    }),
  );
}

export function admissionModelConfigurationChecksum(model: AdmissionModelConfiguration) {
  return fingerprintText(
    JSON.stringify({
      version: model.version,
      modelId: model.modelId,
      promptVersion: model.promptVersion,
      schemaVersion: model.schemaVersion,
      evaluationSuiteVersion: model.evaluationSuiteVersion,
    }),
  );
}

export function admissionPolicyFromDocument(
  policy: Doc<"admissionPolicyVersions">,
): AdmissionPolicy {
  return {
    version: policy.version,
    minimumHumanReviews: policy.minimumHumanReviews,
    overallParticipantCapacity: policy.overallParticipantCapacity,
    criteria: policy.criteria.map((criterion) => ({
      criterionKey: criterion.criterionKey,
      label: criterion.label,
      guidanceByBand: criterion.guidanceByBand,
    })),
    decisionReasonCodes: policy.decisionReasonCodes.map((reason) => ({
      key: reason.key,
      label: reason.label,
      allowedDecisions: [...reason.allowedDecisions],
    })),
    aiRecommendationMode: policy.aiRecommendationMode,
  };
}

export function admissionModelConfigurationFromDocument(
  model: Doc<"admissionModelConfigVersions">,
): AdmissionModelConfiguration {
  return {
    version: model.version,
    modelId: model.modelId,
    promptVersion: model.promptVersion,
    schemaVersion: model.schemaVersion,
    evaluationSuiteVersion: model.evaluationSuiteVersion,
  };
}

export function admissionConfigurationFromDocuments(
  policy: Doc<"admissionPolicyVersions">,
  model: Doc<"admissionModelConfigVersions"> | null,
): AdmissionConfiguration {
  const policyContent = admissionPolicyFromDocument(policy);
  return {
    version: policyContent.version,
    minimumHumanReviews: policyContent.minimumHumanReviews,
    overallParticipantCapacity: policyContent.overallParticipantCapacity,
    criteria: policyContent.criteria,
    decisionReasonCodes: policyContent.decisionReasonCodes,
    model: model ? admissionModelConfigurationFromDocument(model) : null,
  };
}

async function modelForPolicy(
  ctx: ReadCtx,
  policy: Doc<"admissionPolicyVersions">,
  status: Doc<"admissionModelConfigVersions">["status"],
) {
  return ctx.db
    .query("admissionModelConfigVersions")
    .withIndex("by_policy_status", (index) =>
      index.eq("admissionPolicyVersionId", policy._id).eq("status", status),
    )
    .unique();
}

export async function loadAdmissionConfigurationVersion(
  ctx: ReadCtx,
  policy: Doc<"admissionPolicyVersions">,
) {
  const model = await modelForPolicy(ctx, policy, policy.status);
  validateDocumentChecksums(policy, model);
  return {
    policy,
    model,
    configuration: admissionConfigurationFromDocuments(policy, model),
  };
}

function validateDocumentChecksums(
  policy: Doc<"admissionPolicyVersions">,
  model: Doc<"admissionModelConfigVersions"> | null,
) {
  const policyContent = admissionPolicyFromDocument(policy);
  if (admissionPolicyChecksum(policyContent) !== policy.checksum) {
    throw new Error("The admission-policy checksum is invalid.");
  }
  if (policy.aiRecommendationMode === "enabled") {
    if (!model || model.eventId !== policy.eventId) {
      throw new Error("The admission policy requires a matching model configuration.");
    }
    const modelContent = admissionModelConfigurationFromDocument(model);
    if (admissionModelConfigurationChecksum(modelContent) !== model.checksum) {
      throw new Error("The admission-model checksum is invalid.");
    }
  } else if (model) {
    throw new Error("The admission policy disables AI but still has a model configuration.");
  }
}

export async function loadPublishedAdmissionConfiguration(ctx: ReadCtx, event: Doc<"events">) {
  const policyId = event.publishedAdmissionPolicyId;
  const policy = policyId ? await ctx.db.get(policyId) : null;
  if (!policy || policy.eventId !== event._id || policy.status !== "published") {
    throw new ConvexError({
      code: "ADMISSION_POLICY_NOT_PUBLISHED",
      message: "The published admission policy is unavailable.",
    });
  }
  const modelId = event.publishedAdmissionModelConfigId;
  const model = modelId ? await ctx.db.get(modelId) : null;
  if (
    model &&
    (model.eventId !== event._id ||
      model.status !== "published" ||
      model.admissionPolicyVersionId !== policy._id)
  ) {
    throw new Error("The event's published admission-model pointer is invalid.");
  }
  validateDocumentChecksums(policy, model);
  return { policy, model, configuration: admissionConfigurationFromDocuments(policy, model) };
}

async function ensureReleaseLabelIsAvailable(ctx: ReadCtx, eventId: Id<"events">, version: string) {
  const rows = await ctx.db
    .query("admissionPolicyVersions")
    .withIndex("by_event_version", (index) => index.eq("eventId", eventId).eq("version", version))
    .collect();
  if (rows.some((row) => row.status === "published" || row.status === "superseded")) {
    invalidPolicy("That admission policy release label has already been published.");
  }
}

async function ensureAdmissionConfigurationOpen(ctx: ReadCtx, eventId: Id<"events">) {
  const [firstApplication, validatingSubmission, finalizingSubmission] = await Promise.all([
    ctx.db
      .query("applications")
      .withIndex("by_event_state_submitted", (index) => index.eq("eventId", eventId))
      .first(),
    ctx.db
      .query("teamSubmissionAttempts")
      .withIndex("by_event_and_state_and_created_at", (index) =>
        index.eq("eventId", eventId).eq("state", "validating"),
      )
      .first(),
    ctx.db
      .query("teamSubmissionAttempts")
      .withIndex("by_event_and_state_and_created_at", (index) =>
        index.eq("eventId", eventId).eq("state", "finalizing"),
      )
      .first(),
  ]);
  if (firstApplication || validatingSubmission || finalizingSubmission) {
    throw new ConvexError({
      code: "ADMISSION_POLICY_FROZEN",
      message: "Admission configuration closes when the first project submission begins.",
    });
  }
}

export async function saveAdmissionConfigurationDraft(
  ctx: MutationCtx,
  args: {
    event: Doc<"events">;
    actorPersonId: Id<"people">;
    configuration: AdmissionConfiguration;
    expectedDraftPolicyId?: Id<"admissionPolicyVersions">;
    now: number;
  },
) {
  await ensureAdmissionConfigurationOpen(ctx, args.event._id);
  const configuration = normalizeAdmissionConfiguration({
    ...args.configuration,
    model: admissionRecommendationModel,
  });
  const policyContent = admissionPolicyForConfiguration(configuration);
  const policyChecksum = admissionPolicyChecksum(policyContent);
  const modelChecksum = configuration.model
    ? admissionModelConfigurationChecksum(configuration.model)
    : null;
  const currentDraft = await ctx.db
    .query("admissionPolicyVersions")
    .withIndex("by_event_status", (index) =>
      index.eq("eventId", args.event._id).eq("status", "draft"),
    )
    .unique();
  if (currentDraft?._id !== args.expectedDraftPolicyId) {
    throw new ConvexError({
      code: "ADMISSION_CONFIGURATION_DRAFT_CHANGED",
      message: "The admission configuration changed in another session.",
    });
  }
  const currentModel = currentDraft ? await modelForPolicy(ctx, currentDraft, "draft") : null;
  if (
    currentDraft?.checksum === policyChecksum &&
    ((modelChecksum === null && currentModel === null) || currentModel?.checksum === modelChecksum)
  ) {
    return {
      policyVersionId: currentDraft._id,
      modelConfigVersionId: currentModel?._id ?? null,
      policyChecksum,
      modelChecksum,
      changed: false,
    };
  }
  await ensureReleaseLabelIsAvailable(ctx, args.event._id, configuration.version);
  if (currentModel) await ctx.db.patch(currentModel._id, { status: "retired" });
  if (currentDraft) await ctx.db.patch(currentDraft._id, { status: "retired" });
  const policyVersionId = await ctx.db.insert("admissionPolicyVersions", {
    eventId: args.event._id,
    ...policyContent,
    status: "draft",
    checksum: policyChecksum,
    createdByPersonId: args.actorPersonId,
    createdAt: args.now,
  });
  let modelConfigVersionId: Id<"admissionModelConfigVersions"> | null = null;
  if (configuration.model) {
    modelConfigVersionId = await ctx.db.insert("admissionModelConfigVersions", {
      eventId: args.event._id,
      admissionPolicyVersionId: policyVersionId,
      ...configuration.model,
      status: "draft",
      checksum: admissionModelConfigurationChecksum(configuration.model),
      createdByPersonId: args.actorPersonId,
      createdAt: args.now,
    });
  }
  return {
    policyVersionId,
    modelConfigVersionId,
    policyChecksum,
    modelChecksum,
    changed: true,
  };
}

export async function publishAdmissionConfiguration(
  ctx: MutationCtx,
  args: {
    event: Doc<"events">;
    draftPolicyId: Id<"admissionPolicyVersions">;
    expectedPolicyChecksum: string;
    expectedModelConfigId: Id<"admissionModelConfigVersions"> | null;
    expectedModelChecksum: string | null;
    now: number;
  },
) {
  await ensureAdmissionConfigurationOpen(ctx, args.event._id);
  const draft = await ctx.db.get(args.draftPolicyId);
  if (
    !draft ||
    draft.eventId !== args.event._id ||
    draft.status !== "draft" ||
    draft.checksum !== args.expectedPolicyChecksum
  ) {
    throw new ConvexError({
      code: "ADMISSION_CONFIGURATION_DRAFT_CHANGED",
      message: "The admission configuration changed before publication.",
    });
  }
  const draftModel = await modelForPolicy(ctx, draft, "draft");
  if (
    (draftModel?._id ?? null) !== args.expectedModelConfigId ||
    (draftModel?.checksum ?? null) !== args.expectedModelChecksum
  ) {
    throw new ConvexError({
      code: "ADMISSION_CONFIGURATION_DRAFT_CHANGED",
      message: "The admission model configuration changed before publication.",
    });
  }
  validateDocumentChecksums(draft, draftModel);
  const participantPolicy = await loadPublishedParticipantPolicy(ctx, args.event);
  if (draft.overallParticipantCapacity < participantPolicy.normalized.teamMaximumSize) {
    invalidPolicy("Participant capacity cannot be smaller than the maximum team size.");
  }
  await ensureReleaseLabelIsAvailable(ctx, args.event._id, draft.version);
  const published = await loadPublishedAdmissionConfiguration(ctx, args.event);
  const oldCapacity = await ctx.db
    .query("admissionCapacityBuckets")
    .withIndex("by_policy", (index) => index.eq("admissionPolicyVersionId", published.policy._id))
    .unique();
  if (!oldCapacity || oldCapacity.reserved !== 0) {
    throw new Error("The current admission capacity cannot be replaced safely.");
  }
  if (published.model) await ctx.db.patch(published.model._id, { status: "superseded" });
  await ctx.db.patch(published.policy._id, { status: "superseded" });
  await ctx.db.patch(draft._id, { status: "published", publishedAt: args.now });
  if (draftModel) {
    await ctx.db.patch(draftModel._id, { status: "published", publishedAt: args.now });
  }
  await ctx.db.insert("admissionCapacityBuckets", {
    eventId: args.event._id,
    admissionPolicyVersionId: draft._id,
    capacity: draft.overallParticipantCapacity,
    reserved: 0,
    version: 1,
    updatedAt: args.now,
  });
  const eventVersion = args.event.version + 1;
  await ctx.db.patch(args.event._id, {
    publishedAdmissionPolicyId: draft._id,
    publishedAdmissionModelConfigId: draftModel?._id,
    version: eventVersion,
    updatedAt: args.now,
  });
  return {
    policyVersionId: draft._id,
    modelConfigVersionId: draftModel?._id ?? null,
    eventVersion,
  };
}

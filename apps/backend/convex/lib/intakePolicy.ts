import { ConvexError, v } from "convex/values";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import {
  intakeAnswerLength,
  intakeQuestionPurpose,
  type IntakeAnswerLength,
  type IntakeQuestionPurpose,
} from "../values";
import { containsSensitiveProjectText } from "./projectText";
import { fingerprintText, normalizedLongText, normalizedText } from "./strings";

type ReadCtx = QueryCtx | MutationCtx;

const requiredBlockedTerms = [
  "unoriginal",
  "overdone",
  "bad idea",
  "reject",
  "decline",
  "score",
  "judging",
  "winner",
  "why should you win",
] as const;

export const intakePolicyFallbackInput = v.object({
  ordinal: v.number(),
  text: v.string(),
  purposeKey: intakeQuestionPurpose,
  answerLength: intakeAnswerLength,
});

export const intakePolicyPatternInput = v.object({
  stableKey: v.string(),
  description: v.string(),
  supportiveQuestionGuidance: v.string(),
});

export const intakePolicyModelInput = v.union(
  v.object({ mode: v.literal("deterministic") }),
  v.object({
    mode: v.literal("assisted"),
    modelId: v.string(),
    systemInstruction: v.string(),
    instructionVersion: v.string(),
    schemaVersion: v.string(),
    redactionVersion: v.string(),
    questionPolicyVersion: v.string(),
    evaluationSuiteVersion: v.string(),
    maxOutputTokens: v.number(),
    timeoutMs: v.number(),
  }),
);

export const intakePolicyInput = v.object({
  openingText: v.string(),
  initialPrompt: v.string(),
  initialHelpText: v.string(),
  initialIdeaMinLength: v.number(),
  initialIdeaMaxLength: v.number(),
  followUpAnswerMinLength: v.number(),
  followUpAnswerMaxLength: v.number(),
  minimumFollowUpCount: v.number(),
  maximumFollowUpCount: v.number(),
  deterministicFollowUpCount: v.number(),
  questionMaxLength: v.number(),
  allowedPurposeKeys: v.array(intakeQuestionPurpose),
  fallbackQuestions: v.array(intakePolicyFallbackInput),
  blockedTerms: v.array(v.string()),
  commonIdeaPatterns: v.array(intakePolicyPatternInput),
  model: intakePolicyModelInput,
});

export type IntakePolicyFallback = {
  ordinal: number;
  text: string;
  purposeKey: IntakeQuestionPurpose;
  answerLength: IntakeAnswerLength;
};

export type IntakePolicyPattern = {
  stableKey: string;
  description: string;
  supportiveQuestionGuidance: string;
};

export type IntakePolicyModel =
  | { mode: "deterministic" }
  | {
      mode: "assisted";
      modelId: string;
      systemInstruction: string;
      instructionVersion: string;
      schemaVersion: string;
      redactionVersion: string;
      questionPolicyVersion: string;
      evaluationSuiteVersion: string;
      maxOutputTokens: number;
      timeoutMs: number;
    };

export type IntakePolicy = {
  openingText: string;
  initialPrompt: string;
  initialHelpText: string;
  initialIdeaMinLength: number;
  initialIdeaMaxLength: number;
  followUpAnswerMinLength: number;
  followUpAnswerMaxLength: number;
  minimumFollowUpCount: number;
  maximumFollowUpCount: number;
  deterministicFollowUpCount: number;
  questionMaxLength: number;
  allowedPurposeKeys: IntakeQuestionPurpose[];
  fallbackQuestions: IntakePolicyFallback[];
  blockedTerms: string[];
  commonIdeaPatterns: IntakePolicyPattern[];
  model: IntakePolicyModel;
};

export const defaultDeterministicIntakePolicy: IntakePolicy = {
  openingText: "Hello.",
  initialPrompt: "What is your project about?",
  initialHelpText: "A rough description is enough. Tell us what it does and who it helps.",
  initialIdeaMinLength: 20,
  initialIdeaMaxLength: 4_000,
  followUpAnswerMinLength: 5,
  followUpAnswerMaxLength: 1_200,
  minimumFollowUpCount: 1,
  maximumFollowUpCount: 2,
  deterministicFollowUpCount: 2,
  questionMaxLength: 140,
  allowedPurposeKeys: [
    "user",
    "problem",
    "experience",
    "event_goal",
    "tradeoff",
    "risk",
  ],
  fallbackQuestions: [
    {
      ordinal: 1,
      text: "Who would use this first?",
      purposeKey: "user",
      answerLength: "short",
    },
    {
      ordinal: 2,
      text: "What would you most like to finish during Code2Create?",
      purposeKey: "event_goal",
      answerLength: "medium",
    },
  ],
  blockedTerms: [...requiredBlockedTerms],
  commonIdeaPatterns: [
    {
      stableKey: "civic_issue_reporting",
      description: "A tool for reporting potholes, waste, damage, or another civic issue.",
      supportiveQuestionGuidance:
        "Ask what useful action or feedback should happen after someone submits a report.",
    },
  ],
  model: { mode: "deterministic" },
};

function invalidPolicy(message: string): never {
  throw new ConvexError({ code: "INVALID_INTAKE_POLICY", message });
}

function wholeNumber(value: number, field: string, minimum: number, maximum: number) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    invalidPolicy(`${field} must be a whole number from ${minimum} through ${maximum}.`);
  }
  return value;
}

function normalizeStableKey(value: string, field: string) {
  const key = value.trim().toLowerCase();
  if (!/^[a-z][a-z0-9_]{0,59}$/u.test(key)) {
    invalidPolicy(`${field} must start with a letter and use lowercase letters, numbers, or underscores.`);
  }
  return key;
}

function normalizeQuestion(
  value: string,
  field: string,
  maximum: number,
  blockedTerms: readonly string[],
) {
  const question = normalizedText(value, field, 8, maximum);
  if (!question.endsWith("?") || [...question].filter((character) => character === "?").length !== 1) {
    invalidPolicy(`${field} must be one question ending in a question mark.`);
  }
  const lower = question.toLocaleLowerCase("en");
  if (blockedTerms.some((term) => lower.includes(term))) {
    invalidPolicy(`${field} contains wording prohibited by this policy.`);
  }
  if (containsSensitiveProjectText(question)) {
    invalidPolicy(`${field} must not contain contact details, identifiers, or credentials.`);
  }
  return question;
}

function normalizeModel(model: IntakePolicyModel): IntakePolicyModel {
  if (model.mode === "deterministic") return model;
  return {
    mode: "assisted",
    modelId: normalizedText(model.modelId, "Intake model ID", 2, 120),
    systemInstruction: normalizedLongText(
      model.systemInstruction,
      "Intake system instruction",
      100,
      4_000,
    ),
    instructionVersion: normalizedText(model.instructionVersion, "Instruction version", 1, 80),
    schemaVersion: normalizedText(model.schemaVersion, "Output schema version", 1, 80),
    redactionVersion: normalizedText(model.redactionVersion, "Redaction version", 1, 80),
    questionPolicyVersion: normalizedText(
      model.questionPolicyVersion,
      "Question policy version",
      1,
      80,
    ),
    evaluationSuiteVersion: normalizedText(
      model.evaluationSuiteVersion,
      "Evaluation suite version",
      1,
      80,
    ),
    maxOutputTokens: wholeNumber(model.maxOutputTokens, "Maximum output tokens", 200, 1_200),
    timeoutMs: wholeNumber(model.timeoutMs, "Model timeout", 2_000, 15_000),
  };
}

export function normalizeIntakePolicy(input: IntakePolicy): IntakePolicy {
  const openingText = normalizedText(input.openingText, "Opening text", 6, 30);
  if (openingText !== "Hello.") invalidPolicy('The opening must remain exactly "Hello.".');
  const initialPrompt = normalizedText(input.initialPrompt, "Initial prompt", 10, 80);
  if (initialPrompt !== "What is your project about?") {
    invalidPolicy('The initial prompt must remain exactly "What is your project about?".');
  }
  const initialIdeaMinLength = wholeNumber(
    input.initialIdeaMinLength,
    "Initial idea minimum length",
    10,
    200,
  );
  const initialIdeaMaxLength = wholeNumber(
    input.initialIdeaMaxLength,
    "Initial idea maximum length",
    500,
    8_000,
  );
  const followUpAnswerMinLength = wholeNumber(
    input.followUpAnswerMinLength,
    "Follow-up answer minimum length",
    1,
    100,
  );
  const followUpAnswerMaxLength = wholeNumber(
    input.followUpAnswerMaxLength,
    "Follow-up answer maximum length",
    200,
    2_000,
  );
  if (input.minimumFollowUpCount !== 1 || input.maximumFollowUpCount !== 2) {
    invalidPolicy("The introduction must allow one or two follow-up questions.");
  }
  const deterministicFollowUpCount = wholeNumber(
    input.deterministicFollowUpCount,
    "Deterministic follow-up count",
    1,
    2,
  );
  const questionMaxLength = wholeNumber(
    input.questionMaxLength,
    "Question maximum length",
    40,
    140,
  );
  const allowedPurposeKeys = [...input.allowedPurposeKeys];
  if (allowedPurposeKeys.length === 0 || new Set(allowedPurposeKeys).size !== allowedPurposeKeys.length) {
    invalidPolicy("Allowed question purposes must be a non-empty unique set.");
  }
  if (input.blockedTerms.length > 40) {
    invalidPolicy("Blocked wording may contain at most forty entries.");
  }
  const blockedTerms = input.blockedTerms.map((term) =>
    normalizedText(term.toLocaleLowerCase("en"), "Blocked term", 3, 60),
  );
  if (new Set(blockedTerms).size !== blockedTerms.length) {
    invalidPolicy("Blocked wording entries must be unique.");
  }
  for (const required of requiredBlockedTerms) {
    if (!blockedTerms.includes(required)) {
      invalidPolicy(`Blocked wording must include "${required}".`);
    }
  }
  if (input.fallbackQuestions.length !== input.maximumFollowUpCount) {
    invalidPolicy("The policy needs one deterministic fallback for each possible follow-up ordinal.");
  }
  const fallbackQuestions = input.fallbackQuestions
    .map((fallback) => ({
      ordinal: wholeNumber(fallback.ordinal, "Fallback ordinal", 1, input.maximumFollowUpCount),
      text: normalizeQuestion(
        fallback.text,
        `Fallback ${fallback.ordinal}`,
        questionMaxLength,
        blockedTerms,
      ),
      purposeKey: fallback.purposeKey,
      answerLength: fallback.answerLength,
    }))
    .toSorted((left, right) => left.ordinal - right.ordinal);
  if (fallbackQuestions.some((fallback, index) => fallback.ordinal !== index + 1)) {
    invalidPolicy("Fallback ordinals must start at one with no gaps.");
  }
  if (fallbackQuestions.some((fallback) => !allowedPurposeKeys.includes(fallback.purposeKey))) {
    invalidPolicy("Every fallback purpose must be allowed by the question policy.");
  }
  const commonIdeaPatterns = input.commonIdeaPatterns.map((pattern) => ({
    stableKey: normalizeStableKey(pattern.stableKey, "Idea-pattern key"),
    description: normalizedText(pattern.description, "Idea-pattern description", 10, 240),
    supportiveQuestionGuidance: normalizedText(
      pattern.supportiveQuestionGuidance,
      "Idea-pattern guidance",
      10,
      300,
    ),
  }));
  if (commonIdeaPatterns.length > 20) invalidPolicy("An intake policy may contain at most twenty idea patterns.");
  if (new Set(commonIdeaPatterns.map((pattern) => pattern.stableKey)).size !== commonIdeaPatterns.length) {
    invalidPolicy("Idea-pattern keys must be unique.");
  }
  return {
    openingText,
    initialPrompt,
    initialHelpText: normalizedText(input.initialHelpText, "Initial help text", 5, 240),
    initialIdeaMinLength,
    initialIdeaMaxLength,
    followUpAnswerMinLength,
    followUpAnswerMaxLength,
    minimumFollowUpCount: 1,
    maximumFollowUpCount: 2,
    deterministicFollowUpCount,
    questionMaxLength,
    allowedPurposeKeys,
    fallbackQuestions,
    blockedTerms,
    commonIdeaPatterns,
    model: normalizeModel(input.model),
  };
}

export function intakePolicyChecksum(policy: IntakePolicy) {
  return fingerprintText(JSON.stringify(policy));
}

export function intakePolicyFromDocument(policy: Doc<"intakePolicyVersions">): IntakePolicy {
  return {
    openingText: policy.openingText,
    initialPrompt: policy.initialPrompt,
    initialHelpText: policy.initialHelpText,
    initialIdeaMinLength: policy.initialIdeaMinLength,
    initialIdeaMaxLength: policy.initialIdeaMaxLength,
    followUpAnswerMinLength: policy.followUpAnswerMinLength,
    followUpAnswerMaxLength: policy.followUpAnswerMaxLength,
    minimumFollowUpCount: policy.minimumFollowUpCount,
    maximumFollowUpCount: policy.maximumFollowUpCount,
    deterministicFollowUpCount: policy.deterministicFollowUpCount,
    questionMaxLength: policy.questionMaxLength,
    allowedPurposeKeys: policy.allowedPurposeKeys,
    fallbackQuestions: policy.fallbackQuestions,
    blockedTerms: policy.blockedTerms,
    commonIdeaPatterns: policy.commonIdeaPatterns,
    model: policy.model,
  };
}

export async function requirePinnedIntakePolicy(
  ctx: ReadCtx,
  draft: Doc<"projectDrafts">,
) {
  const policy = await ctx.db.get(draft.intakePolicyVersionId);
  if (
    !policy ||
    policy.eventId !== draft.eventId ||
    (policy.status !== "published" && policy.status !== "superseded")
  ) {
    throw new Error("A project draft references an invalid intake policy.");
  }
  const normalized = normalizeIntakePolicy(intakePolicyFromDocument(policy));
  if (intakePolicyChecksum(normalized) !== policy.checksum) {
    throw new Error("A project draft's intake policy checksum is invalid.");
  }
  return { policy, normalized };
}

export async function requirePublishedIntakePolicy(
  ctx: ReadCtx,
  event: Doc<"events">,
) {
  const policyId = event.publishedIntakePolicyId;
  const policy = policyId ? await ctx.db.get(policyId) : null;
  if (!policy || policy.eventId !== event._id || policy.status !== "published") {
    throw new ConvexError({
      code: "INTAKE_POLICY_UNAVAILABLE",
      message: "The event intake policy is unavailable. Try again after operations fixes it.",
    });
  }
  const normalized = normalizeIntakePolicy(intakePolicyFromDocument(policy));
  if (intakePolicyChecksum(normalized) !== policy.checksum) {
    throw new Error("The event's published intake policy checksum is invalid.");
  }
  return { policy, normalized };
}

export async function saveIntakePolicyDraft(
  ctx: MutationCtx,
  args: {
    event: Doc<"events">;
    actorPersonId: Id<"people">;
    policy: IntakePolicy;
    expectedDraftPolicyId?: Id<"intakePolicyVersions">;
    now: number;
  },
) {
  const normalized = normalizeIntakePolicy(args.policy);
  const checksum = intakePolicyChecksum(normalized);
  const currentDraft = await ctx.db
    .query("intakePolicyVersions")
    .withIndex("by_event_status", (index) =>
      index.eq("eventId", args.event._id).eq("status", "draft"),
    )
    .unique();
  if (currentDraft?._id !== args.expectedDraftPolicyId) {
    throw new ConvexError({
      code: "INTAKE_POLICY_DRAFT_CHANGED",
      message: "The intake-policy draft changed in another session. Refresh before saving.",
    });
  }
  if (currentDraft?.checksum === checksum) {
    return {
      policyVersionId: currentDraft._id,
      policyVersion: currentDraft.version,
      checksum,
      changed: false,
    };
  }
  const latest = await ctx.db
    .query("intakePolicyVersions")
    .withIndex("by_event_version", (index) => index.eq("eventId", args.event._id))
    .order("desc")
    .first();
  if (currentDraft) await ctx.db.patch(currentDraft._id, { status: "retired" });
  const policyVersionId = await ctx.db.insert("intakePolicyVersions", {
    eventId: args.event._id,
    version: (latest?.version ?? 0) + 1,
    status: "draft",
    ...normalized,
    checksum,
    createdByPersonId: args.actorPersonId,
    createdAt: args.now,
  });
  const policy = await ctx.db.get(policyVersionId);
  if (!policy) throw new Error("The intake-policy draft did not persist.");
  return {
    policyVersionId,
    policyVersion: policy.version,
    checksum,
    changed: true,
  };
}

export async function publishIntakePolicy(
  ctx: MutationCtx,
  args: {
    event: Doc<"events">;
    draftPolicyId: Id<"intakePolicyVersions">;
    expectedDraftChecksum: string;
    now: number;
  },
) {
  const draft = await ctx.db.get(args.draftPolicyId);
  const currentDraft = await ctx.db
    .query("intakePolicyVersions")
    .withIndex("by_event_status", (index) =>
      index.eq("eventId", args.event._id).eq("status", "draft"),
    )
    .unique();
  if (
    !draft ||
    draft.eventId !== args.event._id ||
    currentDraft?._id !== draft._id ||
    draft.checksum !== args.expectedDraftChecksum
  ) {
    throw new ConvexError({
      code: "INTAKE_POLICY_DRAFT_CHANGED",
      message: "The intake-policy draft changed in another session. Refresh before publishing.",
    });
  }
  const normalized = normalizeIntakePolicy(intakePolicyFromDocument(draft));
  if (intakePolicyChecksum(normalized) !== draft.checksum) {
    throw new Error("The intake-policy draft checksum does not match its content.");
  }
  const publishedId = args.event.publishedIntakePolicyId;
  const published = publishedId ? await ctx.db.get(publishedId) : null;
  if (
    !published ||
    published.eventId !== args.event._id ||
    published.status !== "published"
  ) {
    throw new Error("The event's published intake policy is invalid.");
  }
  await ctx.db.patch(published._id, { status: "superseded" });
  await ctx.db.patch(draft._id, { status: "published", publishedAt: args.now });
  await ctx.db.patch(args.event._id, {
    publishedIntakePolicyId: draft._id,
    version: args.event.version + 1,
    updatedAt: args.now,
  });
  return { policyVersionId: draft._id, policyVersion: draft.version };
}

export function fallbackForOrdinal(policy: IntakePolicy, ordinal: number) {
  const fallback = policy.fallbackQuestions.find((entry) => entry.ordinal === ordinal);
  if (!fallback) throw new Error(`The intake policy has no fallback for ordinal ${ordinal}.`);
  return fallback;
}

export function validateGeneratedIntakeQuestion(
  policy: IntakePolicy,
  args: {
    text: string;
    purposeKey: IntakeQuestionPurpose;
    previousQuestions: readonly string[];
  },
) {
  const text = args.text.trim().replace(/\s+/gu, " ");
  if (
    text.length < 8 ||
    text.length > policy.questionMaxLength ||
    !text.endsWith("?") ||
    [...text].filter((character) => character === "?").length !== 1 ||
    !policy.allowedPurposeKeys.includes(args.purposeKey) ||
    containsSensitiveProjectText(text)
  ) {
    return null;
  }
  const normalized = text.toLocaleLowerCase("en");
  if (
    policy.blockedTerms.some((term) => normalized.includes(term)) ||
    args.previousQuestions.some(
      (question) => question.trim().replace(/\s+/gu, " ").toLocaleLowerCase("en") === normalized,
    )
  ) {
    return null;
  }
  return text;
}

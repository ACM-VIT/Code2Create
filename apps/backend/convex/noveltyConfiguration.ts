import { ConvexError, v, type Infer } from "convex/values";
import { z } from "zod";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { action, internalMutation, mutation, query } from "./_generated/server";
import { authComponent } from "./auth";
import { writeAuditEvent } from "./lib/audit";
import {
  configurationPublicationResultJson,
  storedConfigurationPublicationResult,
  storedConfigurationResult,
} from "./lib/configurationOperationResult";
import { requireEventBySlug } from "./lib/events";
import {
  requireCurrentPerson,
  requireEventSubject,
  requireFreshAuthSession,
  sensitiveCommandSessionMaxAgeMs,
} from "./lib/identity";
import {
  defaultNoveltyPolicy,
  maximumNoveltyCorpusEntries,
  minimumNoveltyCorpusEntries,
  normalizeNoveltyCorpusEntries,
  normalizeNoveltyPolicy,
  noveltyCorpusChecksum,
  noveltyEmbeddingDimensions,
  noveltyEmbeddingModel,
  validEmbedding,
  type NoveltyCorpusEntryInput,
  type NoveltyPolicy,
} from "./lib/novelty";
import { findOperation, operationFingerprint, recordOperation } from "./lib/operations";
import { matchingPermissionGrantIds, requirePermission } from "./lib/permissions";
import { normalizedText } from "./lib/strings";
import { createOpenAiEmbeddings, OpenAiEmbeddingError } from "./lib/openAiEmbeddings";

const noveltyPolicyInput = v.object({
  label: v.string(),
  minimumIdeaLength: v.number(),
  debounceMs: v.number(),
  maximumRequestsPerMinute: v.number(),
  distinctSimilarityBoundary: v.number(),
  commonSimilarityBoundary: v.number(),
  embeddingModel: v.literal("text-embedding-3-small"),
  embeddingDimensions: v.literal(1_536),
});

const corpusEntryInput = v.object({
  sourceKey: v.string(),
  sourceYear: v.number(),
  themeLabel: v.string(),
  summary: v.string(),
  reflectionPrompt: v.string(),
});

const embeddedCorpusEntryInput = v.object({
  sourceKey: v.string(),
  sourceYear: v.number(),
  themeLabel: v.string(),
  summary: v.string(),
  reflectionPrompt: v.string(),
  embedding: v.array(v.float64()),
});

const noveltyDraftOperationResult = z
  .object({
    version: z.number().int().positive(),
    revision: z.number().int().positive(),
    changed: z.boolean(),
  })
  .strict();

const noveltyImportOperationResult = z
  .object({
    revision: z.number().int().positive(),
    entryCount: z.number().int().nonnegative(),
    checksum: z.string().min(1),
  })
  .strict();

const corpusStatus = v.union(
  v.literal("draft"),
  v.literal("published"),
  v.literal("superseded"),
  v.literal("retired"),
);

const importState = v.union(
  v.literal("empty"),
  v.literal("running"),
  v.literal("ready"),
  v.literal("failed"),
);

const corpusView = v.object({
  id: v.id("noveltyCorpusVersions"),
  version: v.number(),
  revision: v.number(),
  status: corpusStatus,
  importState,
  entryCount: v.number(),
  checksum: v.optional(v.string()),
  importFailureCategory: v.optional(v.string()),
  createdAt: v.number(),
  updatedAt: v.number(),
  publishedAt: v.optional(v.number()),
  policy: noveltyPolicyInput,
  entries: v.array(corpusEntryInput),
});

function policyFromDocument(corpus: Doc<"noveltyCorpusVersions">): NoveltyPolicy {
  return {
    label: corpus.label,
    minimumIdeaLength: corpus.minimumIdeaLength,
    debounceMs: corpus.debounceMs,
    maximumRequestsPerMinute: corpus.maximumRequestsPerMinute,
    distinctSimilarityBoundary: corpus.distinctSimilarityBoundary,
    commonSimilarityBoundary: corpus.commonSimilarityBoundary,
    embeddingModel: corpus.embeddingModel,
    embeddingDimensions: noveltyEmbeddingDimensions,
  };
}

function entryFromDocument(entry: Doc<"noveltyCorpusEntries">): NoveltyCorpusEntryInput {
  return {
    sourceKey: entry.sourceKey,
    sourceYear: entry.sourceYear,
    themeLabel: entry.themeLabel,
    summary: entry.summary,
    reflectionPrompt: entry.reflectionPrompt,
  };
}

async function entriesForCorpus(ctx: QueryCtx, corpusId: Doc<"noveltyCorpusVersions">["_id"]) {
  return ctx.db
    .query("noveltyCorpusEntries")
    .withIndex("by_corpus_source", (index) => index.eq("corpusVersionId", corpusId))
    .collect();
}

async function readCorpus(ctx: QueryCtx, corpus: Doc<"noveltyCorpusVersions">) {
  const entries = await entriesForCorpus(ctx, corpus._id);
  return {
    id: corpus._id,
    version: corpus.version,
    revision: corpus.revision,
    status: corpus.status,
    importState: corpus.importState,
    entryCount: corpus.entryCount,
    ...(corpus.checksum !== undefined ? { checksum: corpus.checksum } : {}),
    ...(corpus.importFailureCategory !== undefined
      ? { importFailureCategory: corpus.importFailureCategory }
      : {}),
    createdAt: corpus.createdAt,
    updatedAt: corpus.updatedAt,
    ...(corpus.publishedAt !== undefined ? { publishedAt: corpus.publishedAt } : {}),
    policy: policyFromDocument(corpus),
    entries: entries.map(entryFromDocument),
  };
}

export const current = query({
  args: { eventSlug: v.string() },
  returns: v.object({
    serverNow: v.number(),
    eventVersion: v.number(),
    providerConfigured: v.boolean(),
    publishedCorpus: v.union(v.null(), corpusView),
    draftCorpus: v.union(v.null(), corpusView),
    canDraft: v.boolean(),
    canWriteEntries: v.boolean(),
    canPublish: v.boolean(),
    limits: v.object({ minimumEntries: v.number(), maximumEntries: v.number() }),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "configuration.novelty.read",
      scopeType: "event",
    });
    const publishedCorpus = event.publishedNoveltyCorpusVersionId
      ? await ctx.db.get(event.publishedNoveltyCorpusVersionId)
      : null;
    if (
      publishedCorpus &&
      (publishedCorpus.eventId !== event._id || publishedCorpus.status !== "published")
    ) {
      throw new Error("The event's published novelty corpus is invalid.");
    }
    const draftCorpus = await ctx.db
      .query("noveltyCorpusVersions")
      .withIndex("by_event_status", (index) =>
        index.eq("eventId", event._id).eq("status", "draft"),
      )
      .unique();
    const [draftGrants, entryGrants, publishGrants] = await Promise.all([
      matchingPermissionGrantIds(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "configuration.novelty.draft.create",
        scopeType: "event",
      }),
      matchingPermissionGrantIds(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "configuration.novelty.entries.write",
        scopeType: "event",
      }),
      matchingPermissionGrantIds(ctx, {
        eventId: event._id,
        eventAccessSubjectId: subject._id,
        permissionKey: "configuration.novelty.publish",
        scopeType: "event",
      }),
    ]);
    return {
      serverNow: Date.now(),
      eventVersion: event.version,
      providerConfigured: Boolean(process.env.OPENAI_API_KEY?.trim()),
      publishedCorpus: publishedCorpus ? await readCorpus(ctx, publishedCorpus) : null,
      draftCorpus: draftCorpus ? await readCorpus(ctx, draftCorpus) : null,
      canDraft: draftGrants.length > 0,
      canWriteEntries: entryGrants.length > 0,
      canPublish: publishGrants.length > 0,
      limits: {
        minimumEntries: minimumNoveltyCorpusEntries,
        maximumEntries: maximumNoveltyCorpusEntries,
      },
    };
  },
});

export const createDraft = mutation({
  args: {
    eventSlug: v.string(),
    policy: noveltyPolicyInput,
    expectedEventVersion: v.number(),
    expectedDraftCorpusId: v.optional(v.id("noveltyCorpusVersions")),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    corpusVersionId: v.id("noveltyCorpusVersions"),
    corpusVersion: v.number(),
    revision: v.number(),
    changed: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const normalizedPolicy = normalizeNoveltyPolicy(args.policy);
    const reason = normalizedText(args.reason, "Draft reason", 5, 500);
    const requestFingerprint = operationFingerprint([
      args.expectedEventVersion,
      args.expectedDraftCorpusId ?? null,
      JSON.stringify(normalizedPolicy),
      reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "configuration.novelty_corpus.draft",
      requestFingerprint,
    });
    if (prior) {
      const corpusVersionId = ctx.db.normalizeId("noveltyCorpusVersions", prior.targetId);
      if (!corpusVersionId) throw new Error("The prior novelty-corpus draft result is invalid.");
      const stored = storedConfigurationResult(
        prior.resultJson,
        "novelty-corpus draft",
        noveltyDraftOperationResult,
      );
      return {
        corpusVersionId,
        corpusVersion: stored.version,
        revision: stored.revision,
        changed: stored.changed,
      };
    }
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "configuration.novelty.draft.create",
      scopeType: "event",
    });
    if (event.version !== args.expectedEventVersion) {
      throw new ConvexError({
        code: "EVENT_CONFIGURATION_CHANGED",
        message: "Event configuration changed. Refresh before creating the novelty corpus.",
      });
    }
    const currentDraft = await ctx.db
      .query("noveltyCorpusVersions")
      .withIndex("by_event_status", (index) =>
        index.eq("eventId", event._id).eq("status", "draft"),
      )
      .unique();
    if (currentDraft?._id !== args.expectedDraftCorpusId) {
      throw new ConvexError({
        code: "NOVELTY_CORPUS_DRAFT_CHANGED",
        message: "The novelty-corpus draft changed. Refresh before saving.",
      });
    }
    if (currentDraft?.importState === "running") {
      throw new ConvexError({
        code: "NOVELTY_CORPUS_IMPORT_RUNNING",
        message: "Wait for the current corpus import to finish.",
      });
    }
    const latest = await ctx.db
      .query("noveltyCorpusVersions")
      .withIndex("by_event_version", (index) => index.eq("eventId", event._id))
      .order("desc")
      .first();
    const publishedCorpus = event.publishedNoveltyCorpusVersionId
      ? await ctx.db.get(event.publishedNoveltyCorpusVersionId)
      : null;
    if (
      publishedCorpus &&
      (publishedCorpus.eventId !== event._id || publishedCorpus.status !== "published")
    ) {
      throw new Error("The event's published novelty corpus is invalid.");
    }
    const now = Date.now();
    const sourceCorpus = currentDraft?.entryCount ? currentDraft : publishedCorpus;
    const sourceEntries = sourceCorpus ? await entriesForCorpus(ctx, sourceCorpus._id) : [];
    const normalizedEntries = sourceEntries.length > 0
      ? normalizeNoveltyCorpusEntries(
          sourceEntries.map(entryFromDocument),
          new Date(now).getUTCFullYear(),
        )
      : [];
    if (currentDraft) await ctx.db.patch(currentDraft._id, { status: "retired", updatedAt: now });
    const corpusVersionId = await ctx.db.insert("noveltyCorpusVersions", {
      eventId: event._id,
      version: (latest?.version ?? 0) + 1,
      revision: 1,
      status: "draft",
      importState: normalizedEntries.length > 0 ? "ready" : "empty",
      ...normalizedPolicy,
      entryCount: normalizedEntries.length,
      ...(normalizedEntries.length > 0
        ? { checksum: noveltyCorpusChecksum(normalizedPolicy, normalizedEntries) }
        : {}),
      createdByPersonId: person._id,
      lastEditedByPersonId: person._id,
      createdAt: now,
      updatedAt: now,
    });
    for (const entry of sourceEntries) {
      await ctx.db.insert("noveltyCorpusEntries", {
        eventId: event._id,
        corpusVersionId,
        sourceKey: entry.sourceKey,
        sourceYear: entry.sourceYear,
        themeLabel: entry.themeLabel,
        summary: entry.summary,
        reflectionPrompt: entry.reflectionPrompt,
        embedding: entry.embedding,
        createdAt: now,
      });
    }
    const corpus = await ctx.db.get(corpusVersionId);
    if (!corpus) throw new Error("The novelty-corpus draft did not persist.");
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "configuration.novelty_corpus.draft",
      requestFingerprint,
      targetType: "novelty_corpus",
      targetId: corpusVersionId,
      resultJson: JSON.stringify({
        version: corpus.version,
        revision: corpus.revision,
        changed: true,
      }),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "configuration.novelty.draft.create",
      grantIds,
      scopeType: "event",
      action: "configuration.novelty_corpus_drafted",
      targetType: "novelty_corpus",
      targetId: corpusVersionId,
      nextSummary: JSON.stringify({
        corpusVersion: corpus.version,
        revision: corpus.revision,
        copiedEntryCount: normalizedEntries.length,
        policy: normalizedPolicy,
      }),
      reason,
    });
    return {
      corpusVersionId,
      corpusVersion: corpus.version,
      revision: corpus.revision,
      changed: true,
    };
  },
});

const beginImportResult = v.union(
  v.object({
    kind: v.literal("complete"),
    corpusVersionId: v.id("noveltyCorpusVersions"),
    revision: v.number(),
    entryCount: v.number(),
    checksum: v.string(),
  }),
  v.object({
    kind: v.literal("run"),
    eventId: v.id("events"),
    actorPersonId: v.id("people"),
    corpusVersionId: v.id("noveltyCorpusVersions"),
    runningRevision: v.number(),
    requestFingerprint: v.string(),
    reason: v.string(),
    model: v.literal("text-embedding-3-small"),
    entries: v.array(corpusEntryInput),
  }),
);
type BeginImportResult = Infer<typeof beginImportResult>;
type ReplaceEntriesResult = {
  corpusVersionId: Id<"noveltyCorpusVersions">;
  revision: number;
  entryCount: number;
  checksum: string;
};

export const beginEntryImport = internalMutation({
  args: {
    authUserId: v.string(),
    eventSlug: v.string(),
    corpusVersionId: v.id("noveltyCorpusVersions"),
    expectedRevision: v.number(),
    entries: v.array(corpusEntryInput),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: beginImportResult,
  handler: async (ctx, args): Promise<BeginImportResult> => {
    const person = await ctx.db
      .query("people")
      .withIndex("by_auth_user", (index) => index.eq("authUserId", args.authUserId))
      .unique();
    if (!person || person.status !== "active") {
      throw new ConvexError({ code: "PERSON_NOT_ACTIVE", message: "This account is not active." });
    }
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const subject = await requireEventSubject(ctx, event._id, person._id);
    await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "configuration.novelty.entries.write",
      scopeType: "event",
    });
    const now = Date.now();
    const entries = normalizeNoveltyCorpusEntries(
      args.entries,
      new Date(now).getUTCFullYear(),
    );
    const reason = normalizedText(args.reason, "Import reason", 5, 500);
    const requestFingerprint = operationFingerprint([
      args.corpusVersionId,
      args.expectedRevision,
      JSON.stringify(entries),
      reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "configuration.novelty_corpus.entries.replace",
      requestFingerprint,
    });
    if (prior) {
      const corpusVersionId = ctx.db.normalizeId("noveltyCorpusVersions", prior.targetId);
      if (!corpusVersionId) throw new Error("The stored novelty import is invalid.");
      const stored = storedConfigurationResult(
        prior.resultJson,
        "novelty import",
        noveltyImportOperationResult,
      );
      return {
        kind: "complete",
        corpusVersionId,
        ...stored,
      };
    }
    const corpus = await ctx.db.get(args.corpusVersionId);
    if (!corpus || corpus.eventId !== event._id || corpus.status !== "draft") {
      throw new ConvexError({
        code: "NOVELTY_CORPUS_DRAFT_CHANGED",
        message: "That novelty-corpus draft is no longer current.",
      });
    }
    if (corpus.activeImportOperationId) {
      const sameOperation =
        corpus.activeImportOperationId === args.clientOperationId &&
        corpus.activeImportFingerprint === requestFingerprint;
      throw new ConvexError({
        code: sameOperation ? "NOVELTY_CORPUS_IMPORT_RUNNING" : "NOVELTY_CORPUS_DRAFT_CHANGED",
        message: sameOperation
          ? "That corpus import is still running."
          : "Another corpus import started. Refresh before retrying.",
      });
    }
    if (corpus.revision !== args.expectedRevision) {
      throw new ConvexError({
        code: "NOVELTY_CORPUS_DRAFT_CHANGED",
        message: "The novelty-corpus draft changed. Refresh before importing.",
      });
    }
    const runningRevision = corpus.revision + 1;
    await ctx.db.patch(corpus._id, {
      revision: runningRevision,
      importState: "running",
      activeImportOperationId: args.clientOperationId,
      activeImportFingerprint: requestFingerprint,
      importFailureCategory: undefined,
      lastEditedByPersonId: person._id,
      updatedAt: now,
    });
    return {
      kind: "run",
      eventId: event._id,
      actorPersonId: person._id,
      corpusVersionId: corpus._id,
      runningRevision,
      requestFingerprint,
      reason,
      model: noveltyEmbeddingModel,
      entries,
    };
  },
});

export const finishEntryImport = internalMutation({
  args: {
    actorPersonId: v.id("people"),
    corpusVersionId: v.id("noveltyCorpusVersions"),
    runningRevision: v.number(),
    requestFingerprint: v.string(),
    reason: v.string(),
    clientOperationId: v.string(),
    providerRequestId: v.optional(v.string()),
    latencyMs: v.number(),
    entries: v.array(embeddedCorpusEntryInput),
  },
  returns: v.object({
    corpusVersionId: v.id("noveltyCorpusVersions"),
    revision: v.number(),
    entryCount: v.number(),
    checksum: v.string(),
  }),
  handler: async (ctx, args) => {
    const corpus = await ctx.db.get(args.corpusVersionId);
    if (
      !corpus ||
      corpus.status !== "draft" ||
      corpus.importState !== "running" ||
      corpus.revision !== args.runningRevision ||
      corpus.activeImportOperationId !== args.clientOperationId ||
      corpus.activeImportFingerprint !== args.requestFingerprint
    ) {
      throw new ConvexError({
        code: "NOVELTY_CORPUS_DRAFT_CHANGED",
        message: "The corpus changed before its embeddings could be saved.",
      });
    }
    const now = Date.now();
    const normalizedEntries = normalizeNoveltyCorpusEntries(
      args.entries,
      new Date(now).getUTCFullYear(),
    );
    if (args.entries.some((entry) => !validEmbedding(entry.embedding))) {
      throw new Error("The embedding provider returned an invalid corpus vector.");
    }
    const existingEntries = await ctx.db
      .query("noveltyCorpusEntries")
      .withIndex("by_corpus_source", (index) => index.eq("corpusVersionId", corpus._id))
      .collect();
    for (const entry of existingEntries) await ctx.db.delete(entry._id);
    const embeddingBySource = new Map(
      args.entries.map((entry) => [entry.sourceKey.trim().toLowerCase(), entry.embedding] as const),
    );
    for (const entry of normalizedEntries) {
      const embedding = embeddingBySource.get(entry.sourceKey);
      if (!embedding) throw new Error("A normalized corpus entry has no embedding.");
      await ctx.db.insert("noveltyCorpusEntries", {
        eventId: corpus.eventId,
        corpusVersionId: corpus._id,
        ...entry,
        embedding,
        createdAt: now,
      });
    }
    const policy = normalizeNoveltyPolicy(policyFromDocument(corpus));
    const checksum = noveltyCorpusChecksum(policy, normalizedEntries);
    const revision = corpus.revision + 1;
    await ctx.db.patch(corpus._id, {
      revision,
      importState: "ready",
      entryCount: normalizedEntries.length,
      checksum,
      activeImportOperationId: undefined,
      activeImportFingerprint: undefined,
      importFailureCategory: undefined,
      lastEditedByPersonId: args.actorPersonId,
      updatedAt: now,
    });
    await recordOperation(ctx, {
      eventId: corpus.eventId,
      actorPersonId: args.actorPersonId,
      clientOperationId: args.clientOperationId,
      commandName: "configuration.novelty_corpus.entries.replace",
      requestFingerprint: args.requestFingerprint,
      targetType: "novelty_corpus",
      targetId: corpus._id,
      resultJson: JSON.stringify({
        revision,
        entryCount: normalizedEntries.length,
        checksum,
      }),
      createdAt: now,
    });
    const subject = await requireEventSubject(ctx, corpus.eventId, args.actorPersonId);
    const grantIds = await matchingPermissionGrantIds(ctx, {
      eventId: corpus.eventId,
      eventAccessSubjectId: subject._id,
      permissionKey: "configuration.novelty.entries.write",
      scopeType: "event",
    });
    await writeAuditEvent(ctx, {
      eventId: corpus.eventId,
      actorPersonId: args.actorPersonId,
      permissionKey: "configuration.novelty.entries.write",
      grantIds,
      scopeType: "event",
      action: "configuration.novelty_corpus_entries_replaced",
      targetType: "novelty_corpus",
      targetId: corpus._id,
      nextSummary: JSON.stringify({
        revision,
        entryCount: normalizedEntries.length,
        checksum,
        model: corpus.embeddingModel,
        ...(args.providerRequestId ? { providerRequestId: args.providerRequestId } : {}),
        latencyMs: args.latencyMs,
      }),
      reason: args.reason,
    });
    return {
      corpusVersionId: corpus._id,
      revision,
      entryCount: normalizedEntries.length,
      checksum,
    };
  },
});

export const failEntryImport = internalMutation({
  args: {
    actorPersonId: v.id("people"),
    corpusVersionId: v.id("noveltyCorpusVersions"),
    runningRevision: v.number(),
    requestFingerprint: v.string(),
    clientOperationId: v.string(),
    failureCategory: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const corpus = await ctx.db.get(args.corpusVersionId);
    if (
      !corpus ||
      corpus.status !== "draft" ||
      corpus.importState !== "running" ||
      corpus.revision !== args.runningRevision ||
      corpus.activeImportOperationId !== args.clientOperationId ||
      corpus.activeImportFingerprint !== args.requestFingerprint
    ) {
      return null;
    }
    await ctx.db.patch(corpus._id, {
      revision: corpus.revision + 1,
      importState: "failed",
      activeImportOperationId: undefined,
      activeImportFingerprint: undefined,
      importFailureCategory: args.failureCategory,
      lastEditedByPersonId: args.actorPersonId,
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const replaceEntries = action({
  args: {
    eventSlug: v.string(),
    corpusVersionId: v.id("noveltyCorpusVersions"),
    expectedRevision: v.number(),
    entries: v.array(corpusEntryInput),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    corpusVersionId: v.id("noveltyCorpusVersions"),
    revision: v.number(),
    entryCount: v.number(),
    checksum: v.string(),
  }),
  handler: async (ctx, args): Promise<ReplaceEntriesResult> => {
    const user = await authComponent.getAuthUser(ctx);
    if (!user.emailVerified) {
      throw new ConvexError({
        code: "EMAIL_NOT_VERIFIED",
        message: "Google must verify the email address before it can be used.",
      });
    }
    const begun: BeginImportResult = await ctx.runMutation(
      internal.noveltyConfiguration.beginEntryImport,
      {
      authUserId: user._id,
      ...args,
      },
    );
    if (begun.kind === "complete") return begun;
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) {
      await ctx.runMutation(internal.noveltyConfiguration.failEntryImport, {
        actorPersonId: begun.actorPersonId,
        corpusVersionId: begun.corpusVersionId,
        runningRevision: begun.runningRevision,
        requestFingerprint: begun.requestFingerprint,
        clientOperationId: args.clientOperationId,
        failureCategory: "provider_not_configured",
      });
      throw new ConvexError({
        code: "NOVELTY_PROVIDER_UNAVAILABLE",
        message: "Configure the embedding provider before importing a novelty corpus.",
      });
    }
    const startedAt = Date.now();
    try {
      const response = await createOpenAiEmbeddings({
        apiKey,
        model: begun.model,
        input: begun.entries.map((entry) => `${entry.themeLabel}\n${entry.summary}`),
        timeoutMs: 15_000,
      });
      const ordered = response.data.toSorted((left, right) => left.index - right.index);
      if (
        ordered.length !== begun.entries.length ||
        ordered.some((item, index) => item.index !== index || !validEmbedding(item.embedding))
      ) {
        throw new Error("The embedding provider returned an incomplete corpus batch.");
      }
      return await ctx.runMutation(internal.noveltyConfiguration.finishEntryImport, {
        actorPersonId: begun.actorPersonId,
        corpusVersionId: begun.corpusVersionId,
        runningRevision: begun.runningRevision,
        requestFingerprint: begun.requestFingerprint,
        reason: begun.reason,
        clientOperationId: args.clientOperationId,
        ...(response.requestId ? { providerRequestId: response.requestId } : {}),
        latencyMs: Date.now() - startedAt,
        entries: begun.entries.map((entry, index) => {
          const embedding = ordered[index]?.embedding;
          if (!embedding) throw new Error("A corpus entry has no embedding result.");
          return { ...entry, embedding };
        }),
      });
    } catch (error) {
      const status = error instanceof OpenAiEmbeddingError ? error.status : undefined;
      const failureCategory = status === 429
        ? "provider_rate_limited"
        : status
          ? `provider_http_${status}`
          : error instanceof OpenAiEmbeddingError && error.timedOut
            ? "provider_timed_out"
            : "provider_request_failed";
      await ctx.runMutation(internal.noveltyConfiguration.failEntryImport, {
        actorPersonId: begun.actorPersonId,
        corpusVersionId: begun.corpusVersionId,
        runningRevision: begun.runningRevision,
        requestFingerprint: begun.requestFingerprint,
        clientOperationId: args.clientOperationId,
        failureCategory,
      });
      if (error instanceof ConvexError) throw error;
      throw new ConvexError({
        code: "NOVELTY_PROVIDER_UNAVAILABLE",
        message: "The corpus could not be embedded. The draft remains available to retry.",
      });
    }
  },
});

export const publish = mutation({
  args: {
    eventSlug: v.string(),
    draftCorpusId: v.id("noveltyCorpusVersions"),
    expectedDraftRevision: v.number(),
    expectedDraftChecksum: v.string(),
    expectedEventVersion: v.number(),
    reason: v.string(),
    clientOperationId: v.string(),
  },
  returns: v.object({
    corpusVersionId: v.id("noveltyCorpusVersions"),
    corpusVersion: v.number(),
    eventVersion: v.number(),
  }),
  handler: async (ctx, args) => {
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const { person } = await requireCurrentPerson(ctx);
    const reason = normalizedText(args.reason, "Publication reason", 5, 500);
    const requestFingerprint = operationFingerprint([
      args.draftCorpusId,
      args.expectedDraftRevision,
      args.expectedDraftChecksum,
      args.expectedEventVersion,
      reason,
    ]);
    const prior = await findOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "configuration.novelty_corpus.publish",
      requestFingerprint,
    });
    if (prior) {
      const corpusVersionId = ctx.db.normalizeId("noveltyCorpusVersions", prior.targetId);
      if (!corpusVersionId) {
        throw new Error("The prior novelty-corpus publication is invalid.");
      }
      const stored = storedConfigurationPublicationResult(
        prior.resultJson,
        "novelty-corpus publication",
      );
      return {
        corpusVersionId,
        corpusVersion: stored.version,
        eventVersion: stored.eventVersion,
      };
    }
    const subject = await requireEventSubject(ctx, event._id, person._id);
    const grantIds = await requirePermission(ctx, {
      eventId: event._id,
      eventAccessSubjectId: subject._id,
      permissionKey: "configuration.novelty.publish",
      scopeType: "event",
    });
    await requireFreshAuthSession(ctx, sensitiveCommandSessionMaxAgeMs);
    if (event.version !== args.expectedEventVersion) {
      throw new ConvexError({
        code: "EVENT_CONFIGURATION_CHANGED",
        message: "Event configuration changed. Refresh before publishing the novelty corpus.",
      });
    }
    const corpus = await ctx.db.get(args.draftCorpusId);
    if (
      !corpus ||
      corpus.eventId !== event._id ||
      corpus.status !== "draft" ||
      corpus.importState !== "ready" ||
      corpus.revision !== args.expectedDraftRevision ||
      corpus.checksum !== args.expectedDraftChecksum
    ) {
      throw new ConvexError({
        code: "NOVELTY_CORPUS_DRAFT_CHANGED",
        message: "The novelty-corpus draft changed. Validate it again before publishing.",
      });
    }
    const entries = await ctx.db
      .query("noveltyCorpusEntries")
      .withIndex("by_corpus_source", (index) => index.eq("corpusVersionId", corpus._id))
      .collect();
    const now = Date.now();
    const normalizedEntries = normalizeNoveltyCorpusEntries(
      entries.map(entryFromDocument),
      new Date(now).getUTCFullYear(),
    );
    if (entries.length !== corpus.entryCount) {
      throw new Error("The novelty-corpus entry projection is inconsistent.");
    }
    const checksum = noveltyCorpusChecksum(
      normalizeNoveltyPolicy(policyFromDocument(corpus)),
      normalizedEntries,
    );
    if (checksum !== corpus.checksum) {
      throw new ConvexError({
        code: "NOVELTY_CORPUS_DRAFT_CHANGED",
        message: "The novelty-corpus checksum no longer matches its entries.",
      });
    }
    const previousId = event.publishedNoveltyCorpusVersionId;
    const previous = previousId ? await ctx.db.get(previousId) : null;
    if (previous && (previous.eventId !== event._id || previous.status !== "published")) {
      throw new Error("The event's current novelty corpus is invalid.");
    }
    if (previous) await ctx.db.patch(previous._id, { status: "superseded", updatedAt: now });
    await ctx.db.patch(corpus._id, {
      status: "published",
      revision: corpus.revision + 1,
      publishedAt: now,
      lastEditedByPersonId: person._id,
      updatedAt: now,
    });
    await ctx.db.patch(event._id, {
      publishedNoveltyCorpusVersionId: corpus._id,
      version: event.version + 1,
      updatedAt: now,
    });
    await recordOperation(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      clientOperationId: args.clientOperationId,
      commandName: "configuration.novelty_corpus.publish",
      requestFingerprint,
      targetType: "novelty_corpus",
      targetId: corpus._id,
      resultJson: configurationPublicationResultJson({
        version: corpus.version,
        eventVersion: event.version + 1,
      }),
      createdAt: now,
    });
    await writeAuditEvent(ctx, {
      eventId: event._id,
      actorPersonId: person._id,
      permissionKey: "configuration.novelty.publish",
      grantIds,
      scopeType: "event",
      action: "configuration.novelty_corpus_published",
      targetType: "novelty_corpus",
      targetId: corpus._id,
      previousSummary: JSON.stringify({ corpusVersionId: previousId }),
      nextSummary: JSON.stringify({
        corpusVersion: corpus.version,
        revision: corpus.revision + 1,
        entryCount: corpus.entryCount,
        checksum,
      }),
      reason,
    });
    return {
      corpusVersionId: corpus._id,
      corpusVersion: corpus.version,
      eventVersion: event.version + 1,
    };
  },
});

export const defaults = query({
  args: {},
  returns: noveltyPolicyInput,
  handler: () => defaultNoveltyPolicy,
});

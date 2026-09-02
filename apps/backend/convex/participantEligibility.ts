import { ConvexError, v } from "convex/values";

import { internalMutation, internalQuery } from "./_generated/server";
import { requireEventBySlug } from "./lib/events";
import { normalizeEligibilityIdentity } from "./lib/participantEligibility";
import { normalizedText } from "./lib/strings";
import { participantClass } from "./values";

const seedRow = v.object({
  participantClass,
  identity: v.string(),
  sourceRowNumber: v.number(),
});

function requireProductionEnvironment() {
  if (process.env.C2C_DEPLOYMENT_ENVIRONMENT?.trim() !== "production") {
    throw new ConvexError({
      code: "PRODUCTION_ELIGIBILITY_IMPORT_ONLY",
      message: "Participant eligibility imports run only in production.",
    });
  }
}

function requiredCount(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 10_000) {
    throw new Error(`${label} must be between 1 and 10,000.`);
  }
  return value;
}

function sourceChecksum(value: string, label: string) {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error(`${label} must be a SHA-256 checksum.`);
  }
  return normalized;
}

export const beginImport = internalMutation({
  args: {
    eventSlug: v.string(),
    batchKey: v.string(),
    expectedExternalCount: v.number(),
    expectedVitCount: v.number(),
    externalSourceChecksum: v.string(),
    vitSourceChecksum: v.string(),
  },
  returns: v.object({
    importId: v.id("participantEligibilityImports"),
    status: v.union(v.literal("preparing"), v.literal("active")),
  }),
  handler: async (ctx, args) => {
    requireProductionEnvironment();
    const event = await requireEventBySlug(ctx, args.eventSlug);
    if (event.status !== "draft") {
      throw new ConvexError({
        code: "ELIGIBILITY_IMPORT_REQUIRES_CLOSED_EVENT",
        message: "Close applications before replacing participant eligibility.",
      });
    }
    const batchKey = normalizedText(args.batchKey, "Eligibility batch key", 3, 80);
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(batchKey)) {
      throw new Error("Eligibility batch keys use lowercase letters, numbers, dots, dashes, and underscores.");
    }
    const expectedExternalCount = requiredCount(
      args.expectedExternalCount,
      "Expected external participant count",
    );
    const expectedVitCount = requiredCount(
      args.expectedVitCount,
      "Expected VIT participant count",
    );
    const externalSourceChecksum = sourceChecksum(
      args.externalSourceChecksum,
      "External source checksum",
    );
    const vitSourceChecksum = sourceChecksum(
      args.vitSourceChecksum,
      "VIT source checksum",
    );
    const existing = await ctx.db
      .query("participantEligibilityImports")
      .withIndex("by_event_batch", (index) =>
        index.eq("eventId", event._id).eq("batchKey", batchKey),
      )
      .unique();
    if (existing) {
      if (
        existing.expectedExternalCount !== expectedExternalCount ||
        existing.expectedVitCount !== expectedVitCount ||
        existing.externalSourceChecksum !== externalSourceChecksum ||
        existing.vitSourceChecksum !== vitSourceChecksum ||
        existing.status === "superseded"
      ) {
        throw new ConvexError({
          code: "ELIGIBILITY_IMPORT_BATCH_CONFLICT",
          message: "That eligibility batch key belongs to different source data.",
        });
      }
      return { importId: existing._id, status: existing.status };
    }
    const importId = await ctx.db.insert("participantEligibilityImports", {
      eventId: event._id,
      batchKey,
      status: "preparing",
      expectedExternalCount,
      expectedVitCount,
      externalSourceChecksum,
      vitSourceChecksum,
      createdAt: Date.now(),
    });
    return { importId, status: "preparing" as const };
  },
});

export const appendEntries = internalMutation({
  args: {
    eventSlug: v.string(),
    importId: v.id("participantEligibilityImports"),
    rows: v.array(seedRow),
  },
  returns: v.object({ inserted: v.number(), unchanged: v.number() }),
  handler: async (ctx, args) => {
    requireProductionEnvironment();
    if (args.rows.length < 1 || args.rows.length > 250) {
      throw new Error("Eligibility seed batches must contain between 1 and 250 rows.");
    }
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const eligibilityImport = await ctx.db.get(args.importId);
    if (
      !eligibilityImport ||
      eligibilityImport.eventId !== event._id ||
      eligibilityImport.status !== "preparing"
    ) {
      throw new ConvexError({
        code: "ELIGIBILITY_IMPORT_NOT_PREPARING",
        message: "This participant eligibility import is not accepting rows.",
      });
    }
    let inserted = 0;
    let unchanged = 0;
    for (const row of args.rows) {
      if (!Number.isSafeInteger(row.sourceRowNumber) || row.sourceRowNumber < 1) {
        throw new Error("Eligibility source row numbers must be positive integers.");
      }
      const identityNormalized = normalizeEligibilityIdentity(
        row.participantClass,
        row.identity,
        event,
      );
      const existing = await ctx.db
        .query("participantEligibilityEntries")
        .withIndex("by_import_identity", (index) =>
          index
            .eq("participantEligibilityImportId", eligibilityImport._id)
            .eq("participantClass", row.participantClass)
            .eq("identityNormalized", identityNormalized),
        )
        .unique();
      if (existing) {
        if (existing.sourceRowNumber !== row.sourceRowNumber) {
          throw new ConvexError({
            code: "ELIGIBILITY_IDENTITY_DUPLICATED",
            message: "The same eligibility identity appears on more than one source row.",
          });
        }
        unchanged += 1;
        continue;
      }
      await ctx.db.insert("participantEligibilityEntries", {
        eventId: event._id,
        participantEligibilityImportId: eligibilityImport._id,
        participantClass: row.participantClass,
        identityKind:
          row.participantClass === "vit_student" ? "vit_registration" : "email",
        identityNormalized,
        sourceRowNumber: row.sourceRowNumber,
        createdAt: Date.now(),
      });
      inserted += 1;
    }
    return { inserted, unchanged };
  },
});

export const publishImport = internalMutation({
  args: {
    eventSlug: v.string(),
    importId: v.id("participantEligibilityImports"),
  },
  returns: v.object({ externalCount: v.number(), vitCount: v.number() }),
  handler: async (ctx, args) => {
    requireProductionEnvironment();
    const event = await requireEventBySlug(ctx, args.eventSlug);
    if (event.status !== "draft") {
      throw new ConvexError({
        code: "ELIGIBILITY_IMPORT_REQUIRES_CLOSED_EVENT",
        message: "Close applications before replacing participant eligibility.",
      });
    }
    const eligibilityImport = await ctx.db.get(args.importId);
    if (!eligibilityImport || eligibilityImport.eventId !== event._id) {
      throw new Error("The participant eligibility import does not belong to this event.");
    }
    const [externalEntries, vitEntries] = await Promise.all([
      ctx.db
        .query("participantEligibilityEntries")
        .withIndex("by_import_class", (index) =>
          index
            .eq("participantEligibilityImportId", eligibilityImport._id)
            .eq("participantClass", "external_participant"),
        )
        .collect(),
      ctx.db
        .query("participantEligibilityEntries")
        .withIndex("by_import_class", (index) =>
          index
            .eq("participantEligibilityImportId", eligibilityImport._id)
            .eq("participantClass", "vit_student"),
        )
        .collect(),
    ]);
    if (
      externalEntries.length !== eligibilityImport.expectedExternalCount ||
      vitEntries.length !== eligibilityImport.expectedVitCount
    ) {
      throw new ConvexError({
        code: "ELIGIBILITY_IMPORT_INCOMPLETE",
        message: `Eligibility import contains ${externalEntries.length} external and ${vitEntries.length} VIT identities; expected ${eligibilityImport.expectedExternalCount} and ${eligibilityImport.expectedVitCount}.`,
      });
    }
    if (eligibilityImport.status === "active") {
      return { externalCount: externalEntries.length, vitCount: vitEntries.length };
    }
    if (eligibilityImport.status !== "preparing") {
      throw new Error("A superseded participant eligibility import cannot be published.");
    }
    const now = Date.now();
    const previous = event.publishedParticipantEligibilityImportId
      ? await ctx.db.get(event.publishedParticipantEligibilityImportId)
      : null;
    if (previous && previous._id !== eligibilityImport._id) {
      await ctx.db.patch(previous._id, { status: "superseded", supersededAt: now });
    }
    await ctx.db.patch(eligibilityImport._id, { status: "active", activatedAt: now });
    await ctx.db.patch(event._id, {
      publishedParticipantEligibilityImportId: eligibilityImport._id,
      version: event.version + 1,
      updatedAt: now,
    });
    return { externalCount: externalEntries.length, vitCount: vitEntries.length };
  },
});

export const summary = internalQuery({
  args: { eventSlug: v.string() },
  returns: v.object({
    active: v.boolean(),
    externalCount: v.number(),
    vitCount: v.number(),
    batchKey: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    requireProductionEnvironment();
    const event = await requireEventBySlug(ctx, args.eventSlug);
    const eligibilityImport = event.publishedParticipantEligibilityImportId
      ? await ctx.db.get(event.publishedParticipantEligibilityImportId)
      : null;
    if (!eligibilityImport || eligibilityImport.status !== "active") {
      return { active: false, externalCount: 0, vitCount: 0, batchKey: null };
    }
    const [externalEntries, vitEntries] = await Promise.all([
      ctx.db
        .query("participantEligibilityEntries")
        .withIndex("by_import_class", (index) =>
          index
            .eq("participantEligibilityImportId", eligibilityImport._id)
            .eq("participantClass", "external_participant"),
        )
        .collect(),
      ctx.db
        .query("participantEligibilityEntries")
        .withIndex("by_import_class", (index) =>
          index
            .eq("participantEligibilityImportId", eligibilityImport._id)
            .eq("participantClass", "vit_student"),
        )
        .collect(),
    ]);
    return {
      active: true,
      externalCount: externalEntries.length,
      vitCount: vitEntries.length,
      batchKey: eligibilityImport.batchKey,
    };
  },
});

import { ConvexError, v } from "convex/values";

import type { QueryCtx } from "./_generated/server";
import { query } from "./_generated/server";
import { generatedHandbookDocuments } from "./generatedHandbook";
import { requireEventBySlug } from "./lib/events";
import { requireCurrentPerson, requireEventSubject } from "./lib/identity";
import { requirePermission } from "./lib/permissions";

async function requireHandbookAccess(
  ctx: QueryCtx,
  eventSlug: string,
) {
  const event = await requireEventBySlug(ctx, eventSlug);
  const { person } = await requireCurrentPerson(ctx);
  const subject = await requireEventSubject(ctx, event._id, person._id);
  await requirePermission(ctx, {
    eventId: event._id,
    eventAccessSubjectId: subject._id,
    permissionKey: "handbook.read",
    scopeType: "event",
  });
}

const documentMetadata = v.object({
  slug: v.string(),
  title: v.string(),
  sourcePath: v.string(),
  order: v.number(),
});

export const list = query({
  args: { eventSlug: v.string() },
  returns: v.array(documentMetadata),
  handler: async (ctx, args) => {
    await requireHandbookAccess(ctx, args.eventSlug);
    return generatedHandbookDocuments.map((document) => ({
      slug: document.slug,
      title: document.title,
      sourcePath: document.sourcePath,
      order: document.order,
    }));
  },
});

export const document = query({
  args: { eventSlug: v.string(), slug: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      slug: v.string(),
      title: v.string(),
      sourcePath: v.string(),
      order: v.number(),
      markdown: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    await requireHandbookAccess(ctx, args.eventSlug);
    const document = generatedHandbookDocuments.find((candidate) => candidate.slug === args.slug);
    return document ?? null;
  },
});

export const search = query({
  args: { eventSlug: v.string(), query: v.string() },
  returns: v.array(
    v.object({
      slug: v.string(),
      title: v.string(),
      sourcePath: v.string(),
      snippet: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    await requireHandbookAccess(ctx, args.eventSlug);
    const searchText = args.query.trim().replace(/\s+/gu, " ");
    if (searchText.length < 2 || searchText.length > 80) {
      if (searchText.length === 0) return [];
      throw new ConvexError({
        code: "INVALID_SEARCH",
        message: "Search must contain between 2 and 80 characters.",
      });
    }
    const needle = searchText.toLocaleLowerCase("en");
    const results = [];
    for (const document of generatedHandbookDocuments) {
      const haystack = document.markdown.toLocaleLowerCase("en");
      const matchAt = haystack.indexOf(needle);
      if (matchAt < 0) continue;
      const start = Math.max(0, matchAt - 90);
      const end = Math.min(document.markdown.length, matchAt + searchText.length + 150);
      const rawSnippet = document.markdown
        .slice(start, end)
        .replace(/[#*_`>|\[\]]/gu, "")
        .replace(/\s+/gu, " ")
        .trim();
      results.push({
        slug: document.slug,
        title: document.title,
        sourcePath: document.sourcePath,
        snippet: `${start > 0 ? "…" : ""}${rawSnippet}${end < document.markdown.length ? "…" : ""}`,
      });
      if (results.length === 20) break;
    }
    return results;
  },
});

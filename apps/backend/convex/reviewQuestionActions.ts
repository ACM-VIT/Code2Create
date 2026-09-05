"use node";
import { v } from "convex/values";
import type { FunctionReturnType } from "convex/server";
import { RequestError } from "octokit";
import { z } from "zod";
import {
  reviewQuestionIngressContext,
  reviewQuestionProtocolVersion,
  signServiceBody,
  type ReviewQuestionSource,
  type ReviewQuestionRequest,
} from "@code2create/domain";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalAction, type ActionCtx } from "./_generated/server";
import {
  readStoredArtifactText,
  readStoredFigmaPreview,
} from "./lib/artifactStorage";
import {
  figmaQuestionNodes,
  excludedSourceReason,
  reviewSourceText,
  reviewSourceBatches,
} from "./lib/reviewQuestionSources";
import {
  repositoryInventory,
  repositoryInventoryEntry,
  repositoryBlob,
} from "./lib/reviewRepositoryInventory";
import { repositoryOctokit, isGitHubRateLimit } from "./lib/githubClient";
import {
  requireIntelligenceHmacSecret,
  requireIntelligenceWorkerOrigin,
} from "./lib/intelligenceServiceConfiguration";
import {
  reviewQuestionRequestSchema,
  questionPayloadChecksum,
} from "./lib/reviewQuestionProtocol";
import { operationFingerprint } from "./lib/operations";

type SourceContext = NonNullable<
  FunctionReturnType<typeof internal.reviewQuestions.sourceContext>
>;
const manifestSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("github"),
    entries: z.array(repositoryInventoryEntry),
  }),
  z.object({
    kind: z.literal("figma"),
    sources: z.array(reviewQuestionRequestSchema.shape.sources.element),
  }),
]);
export const prepare = internalAction({
  args: { jobId: v.id("reviewQuestionSets") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const claim = await ctx.runMutation(internal.reviewQuestions.claim, args);
    if (!claim) return null;
    try {
      const context = await ctx.runQuery(
        internal.reviewQuestions.sourceContext,
        { ...args, attempt: claim.attempt },
      );
      if (!context) throw new Error("Source access ended.");
      const sources: ReviewQuestionSource[] = [
        {
          id: "project",
          kind: "project",
          title: "Submitted idea and answers",
          text: reviewSourceText(context.projectText),
          coverage: "captured",
        },
        {
          id: "progress",
          kind: "checkpoint",
          title: "Current and previous review updates",
          text: reviewSourceText(context.checkpointText),
          coverage: "captured",
        },
      ];
      await ctx.runMutation(internal.reviewQuestionParts.initialize, {
        ...args,
        attempt: claim.attempt,
        sources,
        collections: [
          ...context.github.map((r) => ({
            sourceId: r.id,
            kind: "github" as const,
          })),
          ...context.figma.map((f) => ({
            sourceId: f.id,
            kind: "figma" as const,
          })),
        ],
      });
    } catch {
      await ctx.runMutation(internal.reviewQuestions.fail, {
        ...args,
        attempt: claim.attempt,
        failureCode: "evidence_preparation_failed",
      });
    }
    return null;
  },
});
export const collect = internalAction({
  args: { collectionId: v.id("reviewQuestionCollections") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const collection = await ctx.runMutation(
      internal.reviewQuestionParts.claimCollection,
      args,
    );
    if (!collection) return null;
    const identity = { jobId: collection.jobId, attempt: collection.attempt };
    try {
      const context: SourceContext | null = await ctx.runQuery(
        internal.reviewQuestions.sourceContext,
        identity,
      );
      if (!context) throw new Error("Source access ended.");
      const repository = context.github.find(
        (r) => r.id === collection.sourceId,
      );
      const figma = context.figma.find((f) => f.id === collection.sourceId);
      const source = repository ?? figma;
      if (!source) throw new Error("Source missing from the fixed checkpoint.");
      let pending: ReviewQuestionSource[] = [];
      let ordinal = 0;
      const flush = async () => {
        for (const value of reviewSourceBatches(
          pending,
          collection.batchCharacters,
        )) {
          if (
            !(await ctx.runMutation(internal.reviewQuestionParts.append, {
              ...identity,
              ...args,
              offset: collection.offset,
              batch: ordinal++,
              sources: value,
            }))
          )
            throw new Error("Collection superseded.");
        }
        pending = [];
      };
      const append = async (sources: ReviewQuestionSource[]) => {
        for (const source of sources) {
          if (
            pending.reduce((n, s) => n + s.text.length, 0) +
              source.text.length >
              collection.batchCharacters ||
            pending.length >= 80
          )
            await flush();
          pending.push(source);
          if (source.text.length >= collection.batchCharacters) await flush();
        }
      };
      if ((repository && !repository.access) || (figma && !figma.artifact)) {
        if (collection.offset > 0)
          throw new Error("Content access ended during collection.");
        await append([
          {
            id: source.id,
            kind: collection.kind,
            title: source.title.slice(0, 500),
            url: source.url,
            text: `${reviewSourceText(source.metadata)}\nFull contents are unavailable; do not infer that missing functionality is absent.`,
            coverage: "unavailable",
          },
        ]);
        await flush();
        await ctx.runMutation(internal.reviewQuestionParts.collected, {
          ...args,
          offset: collection.offset,
          nextOffset: 1,
          done: true,
          captured: 0,
          excluded: 0,
          unavailable: 1,
        });
        return null;
      }
      let manifest: z.infer<typeof manifestSchema>;
      if (collection.manifestId) {
        const blob = await ctx.storage.get(collection.manifestId);
        if (!blob) throw new Error("Private inventory unavailable.");
        manifest = manifestSchema.parse(JSON.parse(await blob.text()));
      } else {
        if (repository?.access)
          manifest = {
            kind: "github",
            entries: await repositoryInventory(repository.access),
          };
        else if (figma?.artifact)
          manifest = {
            kind: "figma",
            sources: [
              ...figmaQuestionNodes(
                await readStoredArtifactText(figma.artifact),
                {
                  id: figma.id,
                  kind: "figma",
                  title: figma.title,
                  url: figma.url,
                },
              ),
              ...figma.previews.map(
                (preview): ReviewQuestionSource => ({
                  id: `${figma.id}:render:${preview.factId}`,
                  kind: "figma",
                  title: reviewSourceText(
                    `${figma.title} · captured screen ${preview.nodeName}`,
                  ).slice(0, 500),
                  url: `${figma.url}${figma.url.includes("?") ? "&" : "?"}node-id=${encodeURIComponent(preview.nodeId)}`,
                  text: reviewSourceText(
                    JSON.stringify({
                      nodeId: preview.nodeId,
                      nodeName: preview.nodeName,
                      capturedSha256: preview.sha256,
                      scope:
                        "Inspect the attached captured PNG. Static visual evidence only; no runtime or interaction verification.",
                    }),
                  ),
                  image: { factId: preview.factId, sha256: preview.sha256 },
                  coverage: "captured",
                }),
              ),
            ],
          };
        else throw new Error("No readable source.");
        const manifestId = await ctx.storage.store(
          new Blob([JSON.stringify(manifest)], { type: "application/json" }),
        );
        if (
          !(await ctx.runMutation(internal.reviewQuestionParts.saveManifest, {
            ...args,
            manifestId,
          }))
        ) {
          await ctx.storage.delete(manifestId);
          throw new Error("Collection superseded.");
        }
      }
      let captured = 0;
      let excluded = 0;
      const unavailable = 0;
      if (collection.offset === 0)
        await append([
          {
            id: source.id,
            kind: collection.kind,
            title: source.title.slice(0, 500),
            url: source.url,
            text: reviewSourceText(source.metadata),
            coverage: "captured",
          },
        ]);
      let nextOffset: number;
      let done: boolean;
      if (manifest.kind === "github") {
        if (!repository?.access) throw new Error("Repository access ended.");
        const access = repository.access;
        const github = await repositoryOctokit(
          access.installationId,
          access.repositoryId,
        );
        const entries = manifest.entries.slice(
          collection.offset,
          collection.offset + 12,
        );
        for (const entry of entries) {
          const id = `${repository.id}:file:${operationFingerprint([entry.path]).slice(0, 32)}`;
          const path = [access.rootPath, entry.path].filter(Boolean).join("/");
          const url = `https://github.com/${encodeURIComponent(access.owner)}/${encodeURIComponent(access.name)}/blob/${access.headSha}/${path.split("/").map(encodeURIComponent).join("/")}`;
          const base = {
            id,
            kind: "github" as const,
            title: `${repository.title} · ${entry.path}`.slice(0, 500),
            url,
          };
          const reason =
            excludedSourceReason(entry.path) ??
            (entry.type === "commit"
              ? "submodule; connect this repository separately to inspect its contents"
              : entry.mode === "120000"
                ? "symbolic link; not followed"
                : null);
          if (reason) {
            excluded++;
            await append([
              {
                ...base,
                text: `Inventory entry: ${entry.path}. Excluded: ${reason}.`,
                coverage: "unavailable",
              },
            ]);
            continue;
          }
          const text = await repositoryBlob(access, entry, github);
          if (text === null) {
            excluded++;
            await append([
              {
                ...base,
                text: `Inventory entry: ${entry.path}. Binary or non-UTF-8 file; contents were not inspected.`,
                coverage: "unavailable",
              },
            ]);
            continue;
          }
          captured++;
          await append([
            { ...base, text: reviewSourceText(text), coverage: "captured" },
          ]);
        }
        nextOffset = collection.offset + entries.length;
        done = nextOffset >= manifest.entries.length;
      } else {
        const nodes = manifest.sources
          .slice(collection.offset, collection.offset + 80)
          .map(({ url, image, ...node }) => ({
            ...node,
            ...(url ? { url } : {}),
            ...(image ? { image } : {}),
          }));
        captured = nodes.length;
        await append(nodes);
        nextOffset = collection.offset + nodes.length;
        done = nextOffset >= manifest.sources.length;
      }
      await flush();
      await ctx.runMutation(internal.reviewQuestionParts.collected, {
        ...args,
        offset: collection.offset,
        nextOffset,
        done,
        captured,
        excluded,
        unavailable,
      });
    } catch (error) {
      const limited =
        error instanceof RequestError &&
        isGitHubRateLimit(error.status, error.response?.headers ?? {});
      const retryAfter =
        error instanceof RequestError
          ? Number(error.response?.headers["retry-after"] ?? 30) * 1000
          : 10000;
      await ctx.runMutation(internal.reviewQuestionParts.collectionFailed, {
        ...args,
        offset: collection.offset,
        failureCode: limited
          ? "repository_rate_limited"
          : "source_collection_failed",
        delayMs: Number.isFinite(retryAfter) ? retryAfter : 30000,
      });
    }
    return null;
  },
});
function requestBody(
  context: SourceContext,
  identity: {
    jobId: string;
    attempt: number;
    partId: string;
    partAttempt: number;
  },
  stage: ReviewQuestionRequest["stage"],
  sources: ReviewQuestionSource[],
  references: ReviewQuestionRequest["references"],
  images: ReviewQuestionRequest["images"] = [],
) {
  const body: Omit<ReviewQuestionRequest, "payloadChecksum"> = {
    protocolVersion: reviewQuestionProtocolVersion,
    ...identity,
    stage,
    sourceChecksum: context.sourceChecksum,
    model: context.policy.model,
    maximumQuestions: context.policy.maximumQuestions,
    instructions: reviewSourceText(context.policy.instructions),
    criteria: context.criteria,
    sources,
    references,
    images,
  };
  return reviewQuestionRequestSchema.parse({
    ...body,
    payloadChecksum: questionPayloadChecksum(body),
  });
}
export const analyse = internalAction({
  args: { partId: v.id("reviewQuestionParts"), partAttempt: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const state = await ctx.runQuery(
      internal.reviewQuestionParts.partContext,
      args,
    );
    if (!state) return null;
    const context = await ctx.runQuery(internal.reviewQuestions.sourceContext, {
      jobId: state.job._id,
      attempt: state.job.attempt,
    });
    if (!context) return null;
    const images: ReviewQuestionRequest["images"] = [];
    for (const source of state.part.sources) {
      if (!source.image) continue;
      if (state.part.level !== 0 || source.kind !== "figma")
        throw new Error(
          "Images are only allowed in captured Figma inspection batches.",
        );
      const preview = context.figma
        .flatMap((file) => file.previews)
        .find(
          (candidate) =>
            candidate.factId === source.image?.factId &&
            candidate.sha256 === source.image.sha256,
        );
      if (!preview) throw new Error("Captured Figma image access ended.");
      images.push({
        sourceId: source.id,
        sha256: preview.sha256,
        data: await readStoredFigmaPreview(preview),
      });
    }
    const body = requestBody(
      context,
      { jobId: state.job._id, attempt: state.job.attempt, ...args },
      state.part.level === 0 ? "inspect" : "reduce",
      state.part.sources,
      state.part.references,
      images,
    );
    if (
      await ctx.runMutation(internal.reviewQuestionParts.saveRequest, {
        ...args,
        payloadChecksum: body.payloadChecksum,
      })
    )
      await sendQuestionRequest(body);
    return null;
  },
});
export const finalize = internalAction({
  args: { partId: v.id("reviewQuestionParts") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const state = await ctx.runQuery(
      internal.reviewQuestionParts.partContext,
      args,
    );
    if (!state || state.part.state !== "ready" || !state.part.analysis)
      return null;
    const context = await ctx.runQuery(internal.reviewQuestions.sourceContext, {
      jobId: state.job._id,
      attempt: state.job.attempt,
    });
    if (!context) return null;
    const { part, job } = state;
    const cited = new Set(part.analysis?.findings.flatMap((f) => f.sourceIds));
    const references = part.references.filter((r) => cited.has(r.id));
    const sources: ReviewQuestionSource[] = [
      {
        id: "complete-analysis",
        kind: "checkpoint",
        title: "Complete project evidence analysis",
        text: JSON.stringify({
          summary: part.analysis?.summary,
          findings: part.analysis?.findings,
          coverage: job.coverage,
        }),
        coverage: "partial",
      },
    ];
    const body = requestBody(
      context,
      { jobId: job._id, attempt: job.attempt, partId: "final", partAttempt: 1 },
      "questions",
      sources,
      references,
    );
    if (
      await ctx.runMutation(internal.reviewQuestions.storeRequest, {
        jobId: job._id,
        attempt: job.attempt,
        analysisPartId: part._id,
        requestJson: JSON.stringify(body),
      })
    )
      await dispatchQuestionRequest(ctx, {
        jobId: job._id,
        attempt: job.attempt,
        dispatchAttempt: 1,
      });
    return null;
  },
});
async function sendQuestionRequest(
  request: z.infer<typeof reviewQuestionRequestSchema>,
) {
  const body = JSON.stringify(request);
  const timestamp = String(Date.now());
  const signature = await signServiceBody({
    context: reviewQuestionIngressContext,
    secret: requireIntelligenceHmacSecret("INTELLIGENCE_INGRESS_SECRET"),
    timestamp,
    body,
  });
  try {
    const response = await fetch(
      new URL("/v1/review-questions", requireIntelligenceWorkerOrigin()),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-c2c-timestamp": timestamp,
          "x-c2c-signature": signature,
        },
        body,
        signal: AbortSignal.timeout(20000),
      },
    );
    return response.status === 202;
  } catch {
    return false;
  }
}
export const dispatch = internalAction({
  args: {
    jobId: v.id("reviewQuestionSets"),
    attempt: v.number(),
    dispatchAttempt: v.number(),
  },
  returns: v.null(),
  handler: dispatchQuestionRequest,
});
async function dispatchQuestionRequest(
  ctx: ActionCtx,
  args: {
    jobId: Id<"reviewQuestionSets">;
    attempt: number;
    dispatchAttempt: number;
  },
) {
  const body = await ctx.runQuery(internal.reviewQuestions.request, {
    jobId: args.jobId,
    attempt: args.attempt,
  });
  if (!body) return null;
  if (
    !(await sendQuestionRequest(
      reviewQuestionRequestSchema.parse(JSON.parse(body)),
    )) &&
    args.dispatchAttempt < 3
  )
    await ctx.scheduler.runAfter(
      10000,
      internal.reviewQuestionActions.dispatch,
      { ...args, dispatchAttempt: args.dispatchAttempt + 1 },
    );
  return null;
}

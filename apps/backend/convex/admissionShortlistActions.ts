import { v } from "convex/values";
import {
  selectAdmissionShortlist,
  shortlistAuditSchema,
  shortlistCandidateInputSchema,
  shortlistIngressContext,
  shortlistNeighbourPairs,
  shortlistPairSchema,
  shortlistProfileSchema,
  shortlistTaskSchema,
  shortlistVersion,
  signServiceBody,
  type ShortlistComparison,
  type ShortlistTask,
} from "@code2create/domain";
import type { PaginationResult } from "convex/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { internalAction, type ActionCtx } from "./_generated/server";
import {
  requireIntelligenceHmacSecret,
  requireIntelligenceWorkerOrigin,
} from "./lib/intelligenceServiceConfiguration";

async function loadCandidates(
  ctx: ActionCtx,
  runId: Id<"admissionShortlistRuns">,
) {
  const rows: Doc<"admissionShortlistCandidates">[] = [];
  let cursor: string | null = null;
  do {
    const page: PaginationResult<Doc<"admissionShortlistCandidates">> =
      await ctx.runQuery(internal.admissionShortlist.candidatePage, {
        runId,
        paginationOpts: { numItems: 25, cursor },
      });
    rows.push(...page.page);
    if (page.isDone) break;
    cursor = page.continueCursor;
  } while (rows.length <= 1000);
  if (rows.length > 1000) throw new Error("Shortlist event limit exceeded");
  return rows;
}
async function loadJobs(ctx: ActionCtx, runId: Id<"admissionShortlistRuns">) {
  const rows: Doc<"admissionShortlistJobs">[] = [];
  let cursor: string | null = null;
  do {
    const page: PaginationResult<Doc<"admissionShortlistJobs">> =
      await ctx.runQuery(internal.admissionShortlist.jobPage, {
        runId,
        paginationOpts: { numItems: 25, cursor },
      });
    rows.push(...page.page);
    if (page.isDone) break;
    cursor = page.continueCursor;
  } while (rows.length <= 501000);
  return rows;
}

export const dispatchJob = internalAction({
  args: { jobId: v.id("admissionShortlistJobs"), attempt: v.number() },
  handler: async (ctx, args): Promise<void> => {
    try {
      await dispatchAttempt(ctx, args);
    } catch {
      await ctx.runMutation(internal.admissionShortlist.expireJob, args);
    }
  },
});

async function dispatchAttempt(
  ctx: ActionCtx,
  args: { jobId: Id<"admissionShortlistJobs">; attempt: number },
): Promise<void> {
  const dispatch: {
    job: Doc<"admissionShortlistJobs">;
    modelId: string;
  } | null = await ctx.runQuery(internal.admissionShortlist.readJob, {
    jobId: args.jobId,
  });
  if (!dispatch || dispatch.job.attempt !== args.attempt) return;
  const { job, modelId } = dispatch;
  await ctx.scheduler.runAfter(
    7 * 60_000,
    internal.admissionShortlist.expireJob,
    { jobId: job._id, attempt: job.attempt },
  );
  const body = JSON.stringify({
    version: shortlistVersion,
    jobId: job._id,
    runId: job.runId,
    attempt: job.attempt,
    modelId,
    inputJson: job.inputJson,
  });
  const timestamp = String(Date.now());
  const signature = await signServiceBody({
    context: shortlistIngressContext,
    secret: requireIntelligenceHmacSecret("INTELLIGENCE_INGRESS_SECRET"),
    timestamp,
    body,
  });
  const response = await fetch(
    new URL("/v1/admission-shortlist", requireIntelligenceWorkerOrigin()),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-c2c-timestamp": timestamp,
        "x-c2c-signature": signature,
      },
      body,
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (response.status !== 202)
    throw new Error(`Shortlist dispatch returned HTTP ${response.status}`);
  // Hold the existing admission workpool slot until this model job settles;
  // accepting an HTTP receipt must not fan thousands of model tasks out at once.
  const deadline = Date.now() + 7 * 60_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => {
      setTimeout(resolve, 5_000);
    });
    const current = await ctx.runQuery(internal.admissionShortlist.readJob, {
      jobId: args.jobId,
    });
    if (!current || current.job.attempt !== args.attempt) return;
  }
  await ctx.runMutation(internal.admissionShortlist.expireJob, {
    jobId: job._id,
    attempt: job.attempt,
  });
}

export const advance = internalAction({
  args: { runId: v.id("admissionShortlistRuns") },
  handler: async (ctx, args): Promise<void> => {
    try {
      await advanceRun(ctx, args.runId);
    } catch {
      await ctx.runMutation(internal.admissionShortlist.setProgress, {
        runId: args.runId,
        state: "failed",
        preparationDone: false,
        error:
          "Shortlist preparation failed. Check policy, source completeness and provider configuration; retry keeps completed work.",
      });
    }
  },
});

async function advanceRun(
  ctx: ActionCtx,
  runId: Id<"admissionShortlistRuns">,
): Promise<void> {
  let run: Doc<"admissionShortlistRuns"> = await ctx.runQuery(
    internal.admissionShortlist.readRun,
    { runId },
  );
  if (
    ["complete", "stale", "failed"].includes(run.state) ||
    run.pendingJobs > 0
  )
    return;
  let rows = await loadCandidates(ctx, runId);
  if (run.state === "preparing" || run.state === "waiting") {
    let ready = true;
    for (const row of rows)
      ready =
        (await ctx.runMutation(internal.admissionShortlist.hydrate, {
          candidateId: row._id,
        })) && ready;
    if (!ready) {
      await ctx.runMutation(internal.admissionShortlist.setProgress, {
        runId,
        state: "waiting",
        preparationDone: false,
        error:
          "Waiting for current individual assessments. Failed individual reviews must be retried from their application.",
      });
      if (Date.now() - run.createdAt < 30 * 60_000)
        await ctx.scheduler.runAfter(
          30_000,
          internal.admissionShortlistActions.advance,
          { runId },
        );
      return;
    }
    rows = await loadCandidates(ctx, runId);
    await ctx.runMutation(internal.admissionShortlist.setProgress, {
      runId,
      state: "profiling",
      preparationDone: false,
      committedPeople: rows
        .filter((r) => r.committed)
        .reduce((sum, r) => sum + r.teamSize, 0),
      candidateCount: rows.filter((r) => !r.committed).length,
    });
    for (const row of rows.filter((r) => !r.committed)) {
      if (!row.inputJson) throw new Error("Missing frozen input");
      await ctx.runMutation(internal.admissionShortlist.createJob, {
        runId,
        key: `profile:${row.applicationId}`,
        inputJson: JSON.stringify({
          kind: "profile",
          candidate: shortlistCandidateInputSchema.parse(
            JSON.parse(row.inputJson),
          ),
        }),
      });
    }
    await ctx.runMutation(internal.admissionShortlist.setProgress, {
      runId,
      state: "profiling",
      preparationDone: true,
    });
    return;
  }
  if (!run.preparationDone) return;
  const candidates = rows
    .filter((r) => !r.committed)
    .map((row) => {
      if (!row.inputJson || !row.profileJson || !row.embedding)
        throw new Error("Incomplete shortlist profiles");
      return {
        ...shortlistCandidateInputSchema.parse(JSON.parse(row.inputJson)),
        profile: shortlistProfileSchema.parse(JSON.parse(row.profileJson)),
        embedding: row.embedding,
      };
    });
  if (run.state === "profiling") {
    await ctx.runMutation(internal.admissionShortlist.setProgress, {
      runId,
      state: "comparing",
      preparationDone: false,
    });
    const comparable = candidates.filter(
      (c) =>
        c.quality !== "decline" &&
        c.profile.premise.assessment === "supported" &&
        !c.profile.category.datingOrRomanticMatchmaking,
    );
    const byId = new Map(comparable.map((c) => [c.applicationId, c]));
    for (const pair of shortlistNeighbourPairs(comparable)) {
      const left = byId.get(pair.leftId);
      const right = byId.get(pair.rightId);
      if (!left || !right) throw new Error("Invalid comparison pair");
      const task: ShortlistTask = {
        kind: "pair",
        left: leftInput(left),
        right: leftInput(right),
      };
      await ctx.runMutation(internal.admissionShortlist.createJob, {
        runId,
        key: `pair:${pair.leftId}:${pair.rightId}`,
        inputJson: JSON.stringify(task),
      });
    }
    await ctx.runMutation(internal.admissionShortlist.setProgress, {
      runId,
      state: "comparing",
      preparationDone: true,
    });
    return;
  }
  const jobs = await loadJobs(ctx, runId);
  const comparisons: ShortlistComparison[] = [];
  for (const job of jobs) {
    const task = shortlistTaskSchema.parse(JSON.parse(job.inputJson));
    if (task.kind === "pair") {
      if (job.state !== "succeeded" || !job.resultJson)
        throw new Error("Incomplete comparison");
      comparisons.push({
        ...shortlistPairSchema.parse(JSON.parse(job.resultJson)),
        leftId: task.left.applicationId,
        rightId: task.right.applicationId,
      });
    }
  }
  const suggestions = selectAdmissionShortlist(candidates, comparisons, {
    acceptPeople: run.acceptPeople,
    waitlistPeople: run.waitlistPeople,
    remainingCapacity: run.remainingCapacity,
    tolerance: 5,
  });
  if (run.state === "comparing") {
    await ctx.runMutation(internal.admissionShortlist.setProgress, {
      runId,
      state: "auditing",
      preparationDone: false,
    });
    for (let offset = 0; offset < suggestions.length; offset += 25) {
      const batch = suggestions.slice(offset, offset + 25).map((result) => {
        const row = rows.find((r) => r.applicationId === result.applicationId);
        if (!row) throw new Error("Unknown suggestion target");
        return {
          applicationId: row.applicationId,
          suggestion: result.suggestion,
          resultJson: JSON.stringify(result),
        };
      });
      await ctx.runMutation(internal.admissionShortlist.saveSuggestions, {
        runId,
        rows: batch,
      });
    }
    const auditRows = suggestions.map((s) => {
      const c = candidates.find((c) => c.applicationId === s.applicationId);
      if (!c) throw new Error("Missing audit profile");
      return {
        applicationId: s.applicationId,
        suggestion: s.suggestion,
        profile: c.profile,
      };
    });
    for (let offset = 0; offset < auditRows.length; offset += 8)
      await ctx.runMutation(internal.admissionShortlist.createJob, {
        runId,
        key: `audit:${offset}`,
        inputJson: JSON.stringify({
          kind: "audit",
          candidates: auditRows.slice(offset, offset + 10),
        }),
      });
    await ctx.runMutation(internal.admissionShortlist.setProgress, {
      runId,
      state: "auditing",
      preparationDone: true,
    });
    return;
  }
  if (run.state === "auditing") {
    for (const row of rows)
      if (
        !(await ctx.runMutation(internal.admissionShortlist.hydrate, {
          candidateId: row._id,
        }))
      )
        return;
    run = await ctx.runQuery(internal.admissionShortlist.readRun, { runId });
    const totals = Object.fromEntries(
      ["accept", "waitlist", "reject", "unresolved"].map((kind) => [
        kind,
        {
          teams: suggestions.filter((s) => s.suggestion === kind).length,
          people: suggestions
            .filter((s) => s.suggestion === kind)
            .reduce((sum, s) => sum + s.teamSize, 0),
        },
      ]),
    );
    const domains = Object.fromEntries(
      [...new Set(candidates.map((c) => c.profile.domain))].map((domain) => [
        domain,
        suggestions
          .filter(
            (s) =>
              s.suggestion === "accept" &&
              candidates.find((c) => c.applicationId === s.applicationId)
                ?.profile.domain === domain,
          )
          .reduce((n, s) => n + s.teamSize, 0),
      ]),
    );
    const auditWarnings = jobs
      .filter((j) => j.key.startsWith("audit:") && j.resultJson)
      .flatMap(
        (j) =>
          shortlistAuditSchema.parse(JSON.parse(j.resultJson ?? "{}")).warnings,
      );
    await ctx.runMutation(internal.admissionShortlist.complete, {
      runId,
      expected: rows.map((r) => ({
        applicationId: r.applicationId,
        contentVersion: r.contentVersion,
        projectVersionId: r.projectVersionId,
        ...(r.recommendationId ? { recommendationId: r.recommendationId } : {}),
        committed: r.committed,
        applicationVersion: r.applicationVersion,
      })),
      summaryJson: JSON.stringify({
        totals,
        domains,
        comparedPairs: comparisons.length,
        auditWarnings,
        retrieval:
          "Nearest 12 neighbours plus exact profiles; retrieval is not exhaustive proof of uniqueness.",
        targets: { accept: run.acceptPeople, waitlist: run.waitlistPeople },
        committedPeople: run.committedPeople,
        remainingCapacity: run.remainingCapacity,
      }),
    });
  }
}
function leftInput(c: ReturnType<typeof shortlistCandidateInputSchema.parse>) {
  return {
    applicationId: c.applicationId,
    teamSize: c.teamSize,
    experienceBand: c.experienceBand,
    sources: c.sources,
    criteria: c.criteria,
    quality: c.quality,
  };
}

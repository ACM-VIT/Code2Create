import { describe, expect, test } from "vitest";
import * as v from "valibot";

import {
  autonomyDigestMergeResultSchema,
  operationsAutonomyDispatchRequestSchema,
} from "./autonomyProtocol.ts";
import {
  autonomyEvidenceDigestSchema,
  validateMergedEvidence,
  validateSynthesizedEvidence,
  type AutonomyEvidenceDigest,
} from "./autonomyEvidence.ts";
import { indexAutonomyEvidence } from "./autonomySynthesis.ts";
import { evidenceRecordsForDigest } from "./autonomyCatalog.ts";
import { memoryAutonomyArtifactStore } from "./autonomyArtifacts.ts";
import { registerDigestCandidateEffects } from "./autonomyCandidateOwnership.ts";
import {
  autonomyProgressSchema,
  queueAutonomyDigest,
  readingAutonomyProgress,
  workItemAlreadyApplied,
} from "./autonomyTraversal.ts";
import type { AutonomyPlan } from "./autonomyExecution.ts";

const citation = (args: {
  operationId: string;
  snapshot: string;
  itemId: string;
  version: number;
}) => ({
  read: "operations_attention" as const,
  generatedAt: 100,
  operationId: args.operationId,
  snapshot: args.snapshot,
  keys: [args.itemId, String(args.version)],
});

function candidate(args: {
  operationId: string;
  snapshot: string;
  itemId: string;
  version: number;
}) {
  return {
    statement: `Dismiss ${args.itemId} after exact operator review.`,
    reasoning: "The exact row and version are cited; recurrence remains a counter-hypothesis.",
    citations: [citation(args)],
    arguments: {
      kind: "dismiss_attention_item" as const,
      itemId: args.itemId,
      expectedItemVersion: args.version,
      reason: "The exact item is ready for a human decision.",
    },
  };
}

function digest(args: {
  id: string;
  operationId: string;
  snapshot: string;
  itemId: string;
  version: number;
  children?: string[];
  pageCount?: number;
}): AutonomyEvidenceDigest {
  const source = citation(args);
  const identity = args.id.length === 64 ? args.id : args.id.repeat(64);
  return v.parse(autonomyEvidenceDigestSchema, {
    digestId: `digest-${identity}`,
    recordScope: "source",
    sourceOrdinal: Number.parseInt(identity.slice(-8), 16),
    pageCount: args.pageCount ?? 1,
    content: {
      summary: `The bounded evidence contains ${args.itemId}.`,
      findings: [
        {
          statement: `Attention item ${args.itemId} remains actionable. ${"Evidence remains independently addressable. ".repeat(6)}`,
          uncertainty: `The item can change after this exact versioned snapshot. ${"A later exact page can change the conclusion. ".repeat(5)}`,
          citations: [source],
        },
      ],
      observedSignalKeys: ["projection_coverage_limited"],
    },
    candidates: [candidate(args)],
    children: args.children ?? [],
  });
}

function input() {
  return v.parse(operationsAutonomyDispatchRequestSchema, {
    protocolVersion: "operations-intelligence-v1",
    trigger: "manual",
    runId: "run-evidence",
    eventSlug: "code2create-7",
    policy: {
      policyVersionId: "policy-1",
      policyVersion: 1,
      policyChecksum: "a".repeat(64),
      mode: "recommend",
      escalationSeverity: "attention",
      allowedReadTools: ["operations_health", "operations_attention"],
      allowedRecommendationKinds: ["dismiss_attention_item"],
    },
    source: {
      sourceChecksum: "b".repeat(64),
      snapshot: {
        generatedAt: 1,
        event: {
          slug: "code2create-7",
          name: "Code2Create",
          timezone: "Asia/Dubai",
          status: "live",
        },
        summary: {
          status: "attention",
          signalCount: 1,
          criticalSignalCount: 0,
          attentionSignalCount: 1,
          watchSignalCount: 0,
        },
        signals: [
          {
            key: "projection_coverage_limited",
            area: "system",
            severity: "attention",
            title: "Coverage needs review",
            detail: "Inspect every page before deciding.",
            owner: "Operations",
            nextAction: "Inspect the paginated evidence",
            count: 2,
            atLeast: false,
          },
        ],
      },
    },
  });
}

function targetFor(args: {
  operationId: string;
  snapshot: string;
  itemId: string;
  version: number;
}) {
  return {
    kind: "dismiss_attention_item" as const,
    itemId: args.itemId,
    expectedItemVersion: args.version,
    citation: citation(args),
  };
}

function recoverCursor(cursor: string) {
  return v.parse(v.strictObject({ cursor: v.string() }), JSON.parse(JSON.stringify({ cursor })))
    .cursor;
}

describe("autonomy hierarchical evidence", () => {
  test("pages more than eight unresolved hypotheses into later evidence after cold restart", async () => {
    const artifacts = memoryAutonomyArtifactStore();
    let hypothesisRoots: AutonomyEvidenceDigest[] = [];
    for (let index = 0; index < 12; index += 1) {
      const source = digest({
        id: (index + 1).toString(16),
        operationId: `read-hypothesis-${index}`,
        snapshot: "snapshot-hypotheses",
        itemId: `hypothesis-${index}`,
        version: index + 1,
      });
      const finding = source.content.findings[0];
      if (finding === undefined) throw new Error("The source hypothesis has no finding.");
      await artifacts.putDigest(source);
      const sourceRecord = (await evidenceRecordsForDigest(source)).find(
        (record) => record.kind === "finding",
      );
      if (sourceRecord === undefined) throw new Error("The source has no finding record.");
      const hypothesis = v.parse(autonomyEvidenceDigestSchema, {
        digestId: `digest-${(index + 32).toString(16).padStart(64, "0")}`,
        recordScope: "derived",
        pageCount: 0,
        content: {
          summary: `Unresolved durable hypothesis ${index}.`,
          findings: [{ ...finding, supportRecordIds: [sourceRecord.recordId] }],
          observedSignalKeys: ["projection_coverage_limited"],
        },
        candidates: [],
        children: [],
      });
      await artifacts.putDigest(hypothesis);
      hypothesisRoots.push(hypothesis);
    }
    while (hypothesisRoots.length > 1) {
      const next: AutonomyEvidenceDigest[] = [];
      for (let index = 0; index < hypothesisRoots.length; index += 2) {
        const left = hypothesisRoots[index];
        const right = hypothesisRoots[index + 1];
        if (left === undefined) throw new Error("The hypothesis root is unavailable.");
        if (right === undefined) {
          next.push(left);
          continue;
        }
        const parent = await indexAutonomyEvidence({ kind: "accumulator", digests: [left, right] });
        await artifacts.putDigest(parent);
        next.push(parent);
      }
      hypothesisRoots = next;
    }
    const hypothesisRoot = hypothesisRoots[0];
    if (hypothesisRoot === undefined) throw new Error("The hypothesis catalog has no root.");
    const later = digest({
      id: "f",
      operationId: "read-later-fact",
      snapshot: "snapshot-later",
      itemId: "later-fact",
      version: 20,
    });
    const laterRecord = (await evidenceRecordsForDigest(later)).find(
      (record) => record.kind === "finding",
    );
    if (laterRecord === undefined) throw new Error("The later evidence has no finding record.");

    let cursor: string | undefined;
    let completed = 0;
    for (;;) {
      const recoveredCursor = cursor === undefined ? undefined : recoverCursor(cursor);
      const page = await artifacts.readHypothesisRecords({
        rootDigestIds: [hypothesisRoot.digestId],
        ...(recoveredCursor === undefined ? {} : { afterRecordId: recoveredCursor }),
        limit: 4,
      });
      for (const hypothesis of page.records) {
        if (hypothesis.record.kind !== "finding") {
          throw new Error("The test hypothesis record is not a finding.");
        }
        const result = v.parse(autonomyDigestMergeResultSchema, {
          digest: {
            summary: "A later exact fact completed one durable unresolved hypothesis.",
            findings: [
              {
                statement: `The later fact resolves hypothesis ${hypothesis.record.recordId}.`,
                uncertainty: "The resulting effect still requires explicit human approval.",
                citations: [
                  ...hypothesis.record.finding.citations,
                  ...laterRecord.finding.citations,
                ],
                supportRecordIds: [hypothesis.record.recordId, laterRecord.recordId],
              },
            ],
            observedSignalKeys: ["projection_coverage_limited"],
          },
          candidates: [],
          complete: true,
        });
        await expect(
          validateSynthesizedEvidence({
            input: input(),
            digests: [later],
            records: [hypothesis.record, laterRecord],
            result,
            hasTarget: artifacts.hasTarget,
          }),
        ).resolves.toBeDefined();
        completed += 1;
      }
      if (page.isDone) break;
      if (page.nextRecordId === undefined) {
        throw new Error("The incomplete hypothesis page has no cursor.");
      }
      cursor = page.nextRecordId;
    }
    expect(completed).toBe(12);
  });

  test("pages every lossless finding and candidate across a cold synthesis cursor", async () => {
    const artifacts = memoryAutonomyArtifactStore();
    const leaves: AutonomyEvidenceDigest[] = [];
    for (let index = 0; index < 10; index += 1) {
      const leaf = digest({
        id: index.toString(16),
        operationId: `read-early-${index}`,
        snapshot: "snapshot-early",
        itemId: `item-early-${index}`,
        version: index + 1,
      });
      await artifacts.putDigest(leaf);
      leaves.push(leaf);
    }
    let frontier = leaves;
    while (frontier.length > 1) {
      const next: AutonomyEvidenceDigest[] = [];
      for (let index = 0; index < frontier.length; index += 3) {
        const group = frontier.slice(index, index + 3);
        const parent = await indexAutonomyEvidence({ kind: "root", digests: group });
        await artifacts.putDigest(parent);
        next.push(parent);
      }
      frontier = next;
    }
    const leftRoot = frontier[0];
    if (leftRoot === undefined) throw new Error("The test catalog has no root.");
    const later = digest({
      id: "f",
      operationId: "read-later",
      snapshot: "snapshot-later",
      itemId: "item-later",
      version: 11,
    });
    await artifacts.putDigest(later);

    const recoveredFindings = new Set<string>();
    let pairCursor: string | undefined;
    let pairPageCount = 0;
    for (;;) {
      const page = await artifacts.readSynthesisPairs({
        leftDigestId: leftRoot.digestId,
        rightDigestId: later.digestId,
        ...(pairCursor === undefined ? {} : { cursor: pairCursor }),
        limit: 4,
      });
      for (const pair of page.pairs) {
        if (pair.left.kind === "finding") {
          recoveredFindings.add(pair.left.finding.statement);
        }
      }
      pairPageCount += 1;
      pairCursor = page.cursor === undefined ? undefined : recoverCursor(page.cursor);
      if (page.isDone) break;
    }
    expect(pairPageCount).toBeGreaterThan(1);
    expect(recoveredFindings).toEqual(
      new Set(leaves.flatMap((leaf) => leaf.content.findings.map((finding) => finding.statement))),
    );

    const candidateItems = new Set<string>();
    let candidateCursor: string | undefined;
    let candidatePageCount = 0;
    for (;;) {
      const page = await artifacts.readCandidateRecords({
        rootDigestId: leftRoot.digestId,
        ...(candidateCursor === undefined ? {} : { cursor: candidateCursor }),
        limit: 3,
      });
      for (const record of page.records) {
        if (record.candidate.arguments.kind === "dismiss_attention_item") {
          candidateItems.add(record.candidate.arguments.itemId);
        }
      }
      candidatePageCount += 1;
      candidateCursor = page.cursor === undefined ? undefined : recoverCursor(page.cursor);
      if (page.isDone) break;
    }
    expect(candidatePageCount).toBeGreaterThan(1);
    expect(candidateItems).toEqual(new Set(leaves.map((_, index) => `item-early-${index}`)));
  });

  test("accepts a later-page target and rejects cross-page id/version splicing", async () => {
    const leftArgs = {
      id: "a",
      operationId: "read-page-1",
      snapshot: "snapshot-1",
      itemId: "item-left",
      version: 1,
    };
    const rightArgs = {
      id: "b",
      operationId: "read-page-2",
      snapshot: "snapshot-1",
      itemId: "item-right",
      version: 7,
    };
    const left = digest(leftArgs);
    const right = digest(rightArgs);
    const leftFindingRecord = (await evidenceRecordsForDigest(left)).find(
      (record) => record.kind === "finding",
    );
    const rightFindingRecord = (await evidenceRecordsForDigest(right)).find(
      (record) => record.kind === "finding",
    );
    if (leftFindingRecord === undefined || rightFindingRecord === undefined) {
      throw new Error("The merge fixtures have no finding records.");
    }
    const artifacts = memoryAutonomyArtifactStore();
    await artifacts.putTargets([targetFor(leftArgs), targetFor(rightArgs)]);
    const valid = v.parse(autonomyDigestMergeResultSchema, {
      digest: {
        summary: "Both complete pages were reduced without changing provenance.",
        findings: [
          { ...left.content.findings[0], supportRecordIds: [leftFindingRecord.recordId] },
          { ...right.content.findings[0], supportRecordIds: [rightFindingRecord.recordId] },
        ],
        observedSignalKeys: ["projection_coverage_limited"],
      },
      candidates: [{ ...candidate(rightArgs), supportRecordIds: [rightFindingRecord.recordId] }],
      complete: true,
    });

    await expect(
      validateMergedEvidence({
        input: input(),
        left,
        right,
        result: valid,
        hasTarget: artifacts.hasTarget,
      }),
    ).resolves.toBeDefined();

    const spliced = v.parse(autonomyDigestMergeResultSchema, {
      ...valid,
      candidates: [
        {
          ...candidate(rightArgs),
          supportRecordIds: [leftFindingRecord.recordId],
          citations: [citation(leftArgs), citation(rightArgs)],
          arguments: {
            ...candidate(rightArgs).arguments,
            itemId: leftArgs.itemId,
          },
        },
      ],
    });
    await expect(
      validateMergedEvidence({
        input: input(),
        left,
        right,
        result: spliced,
        hasTarget: artifacts.hasTarget,
      }),
    ).rejects.toThrow(/laundered/u);
  });

  test("stores evidence outside bounded progress and resumes by stable artifact id", async () => {
    const artifacts = memoryAutonomyArtifactStore();
    const plan: AutonomyPlan = {
      playbooks: ["health-triage", "attention-hygiene"],
      focusSignalKeys: [],
      reads: ["operations_health", "operations_attention"],
    };
    let progress = readingAutonomyProgress({ workItemId: "work-plan", plan });
    let logicalArtifactBytes = 0;
    const artifactCount = 9_000;
    for (let index = 0; index < artifactCount; index += 1) {
      const id = index.toString(16).padStart(64, "0");
      const page = digest({
        id,
        operationId: `read-page-${index}`,
        snapshot: "snapshot-many",
        itemId: `item-${index}`,
        version: index + 1,
      });
      await artifacts.putDigest(page);
      logicalArtifactBytes += JSON.stringify(page).length;
      const level = index % 11;
      const reductionLevels = [...progress.reductionLevels];
      reductionLevels[level] = page.digestId;
      progress = {
        ...progress,
        completedWorkItemId: `work-${index}`,
        reductionLevels,
      };
    }
    const serialized = JSON.stringify(progress);
    expect(logicalArtifactBytes).toBeGreaterThan(12 * 1_024 * 1_024);
    expect(serialized.length).toBeLessThan(8_192);
    const recovered = v.parse(autonomyProgressSchema, JSON.parse(serialized));
    expect(workItemAlreadyApplied(recovered, `work-${artifactCount - 1}`)).toBe(true);
    if (recovered.stage !== "reading") throw new Error("Recovered the wrong stage.");
    const artifactId = recovered.reductionLevels.find((value) => value !== null);
    if (artifactId === undefined) throw new Error("Recovered no artifact pointer.");
    await expect(artifacts.getDigest(artifactId)).resolves.toMatchObject({ digestId: artifactId });
  }, 15_000);

  test("retains every same-effect variant for final exhaustive adjudication", async () => {
    const artifacts = memoryAutonomyArtifactStore();
    const args = {
      id: "a",
      operationId: "read-owner",
      snapshot: "snapshot-owner",
      itemId: "item-owner",
      version: 3,
    };
    const child = digest(args);
    const parent = digest({ ...args, id: "b", children: [child.digestId], pageCount: 2 });
    await artifacts.putDigest(child);
    await artifacts.putDigest(parent);
    await registerDigestCandidateEffects({
      eventSlug: "code2create-7",
      digest: child,
      artifacts,
    });
    await registerDigestCandidateEffects({
      eventSlug: "code2create-7",
      digest: parent,
      artifacts,
    });

    await artifacts.prepareRootCatalog({ rootDigestId: parent.digestId, limit: 16 });
    const effects = await artifacts.readCandidateEffects({
      rootDigestId: parent.digestId,
      limit: 1,
    });
    expect(effects.effectKeys).toHaveLength(1);
    const effectKey = effects.effectKeys[0];
    if (effectKey === undefined) throw new Error("The candidate effect was not indexed.");
    const variants = await artifacts.readCandidateEffectVariants({
      rootDigestId: parent.digestId,
      effectKey,
      limit: 2,
    });
    expect(variants.records).toHaveLength(2);
  });

  test("pages every same-effect variant across cold cursor recovery", async () => {
    const artifacts = memoryAutonomyArtifactStore();
    const variantCount = 41;
    const leaves: AutonomyEvidenceDigest[] = [];
    for (let index = 0; index < variantCount; index += 1) {
      const value = digest({
        id: index.toString(16).padStart(64, "0"),
        operationId: `variant-read-${index}`,
        snapshot: `variant-snapshot-${index}`,
        itemId: "same-effect-item",
        version: 7,
      });
      await artifacts.putDigest(value);
      await registerDigestCandidateEffects({
        eventSlug: "code2create-7",
        digest: value,
        artifacts,
      });
      leaves.push(value);
    }
    let frontier = leaves;
    while (frontier.length > 1) {
      const next: AutonomyEvidenceDigest[] = [];
      for (let index = 0; index < frontier.length; index += 3) {
        const root = await indexAutonomyEvidence({
          kind: "root",
          digests: frontier.slice(index, index + 3),
        });
        await artifacts.putDigest(root);
        next.push(root);
      }
      frontier = next;
    }
    const root = frontier[0];
    if (root === undefined) throw new Error("The variants have no root.");
    await artifacts.prepareRootCatalog({ rootDigestId: root.digestId, limit: 16 });
    const effects = await artifacts.readCandidateEffects({ rootDigestId: root.digestId, limit: 1 });
    const effectKey = effects.effectKeys[0];
    if (effectKey === undefined) throw new Error("The candidate effect was not indexed.");
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (;;) {
      const page = await artifacts.readCandidateEffectVariants({
        rootDigestId: root.digestId,
        effectKey,
        ...(cursor === undefined ? {} : { cursor }),
        limit: 3,
      });
      for (const record of page.records) seen.add(record.recordId);
      if (page.isDone) break;
      if (page.cursor === undefined) throw new Error("The variant page has no cursor.");
      cursor = recoverCursor(page.cursor);
    }
    expect(seen.size).toBe(variantCount);
  });

  test("keeps the binary reducer frontier logarithmic and finalizes by root id", () => {
    const plan: AutonomyPlan = {
      playbooks: ["health-triage"],
      focusSignalKeys: [],
      reads: ["operations_health"],
    };
    const progress = readingAutonomyProgress({ workItemId: "work-plan", plan });
    const first = queueAutonomyDigest({
      progress,
      digestId: `digest-${"a".repeat(64)}`,
      level: 0,
      resume: "reading",
      workItemId: "work-page-1",
    });
    expect(first.stage).toBe("reading");
    if (first.stage !== "reading") throw new Error("Expected reading progress.");
    const pending = queueAutonomyDigest({
      progress: first,
      digestId: `digest-${"b".repeat(64)}`,
      level: 0,
      resume: "finalizing",
      workItemId: "work-page-2",
    });
    expect(pending.stage).toBe("reducing");
    if (pending.stage !== "reducing") throw new Error("Expected pending reduction.");
    const rootId = `digest-${"c".repeat(64)}`;
    const finalizing = queueAutonomyDigest({
      progress: pending,
      digestId: rootId,
      level: pending.pending.targetLevel,
      resume: pending.pending.resume,
      workItemId: "work-merge",
    });
    expect(finalizing.stage).toBe("finalizing");
    if (finalizing.stage !== "finalizing") throw new Error("Expected finalization.");
    expect(finalizing.finalDigestId).toBe(rootId);
    expect(finalizing.effectCursor).toBeUndefined();
  });
});

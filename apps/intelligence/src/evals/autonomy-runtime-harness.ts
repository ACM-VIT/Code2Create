import { operationsHealthSignalKeys } from "@code2create/domain";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type Context,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai";
import { AgentRunError, init, instrument } from "@flue/runtime";
import { sqlite, start, type Flue } from "@flue/runtime/node";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import * as v from "valibot";

import { OperationsAutopilot } from "../agents/operations-autopilot.ts";
import { autonomyEvidenceRecordSchema } from "../lib/autonomyCatalog.ts";
import { clearAutonomyRunForTests } from "../lib/autonomyContext.ts";
import { createAutonomyInstrumentation } from "../lib/autonomyInstrumentation.ts";
import {
  autonomyHypothesisSynthesisResultSchema,
  autonomySynthesisResultSchema,
} from "../lib/autonomyProtocol.ts";
import { operationsIntelligenceModelId } from "../lib/model.ts";
import { resetAutonomyEvaluationArtifacts } from "./autonomy-artifacts.ts";
import {
  autonomyEvaluationInjection,
  autonomyEvaluationInput,
  autonomyObserveEvaluationInput,
  finalAttentionItem,
  SignedAutonomyEvaluationBackend,
} from "./autonomy-harness.ts";
import {
  autonomyEvaluationTerminalEffects,
  resetAutonomyEvaluationTerminalEffects,
} from "./worker-env.ts";

const sourceRecordPairSchema = v.strictObject({
  pairId: v.pipe(v.string(), v.minLength(1)),
  left: autonomyEvidenceRecordSchema,
  right: autonomyEvidenceRecordSchema,
});
const hypothesisRecordSchema = v.strictObject({
  record: autonomyEvidenceRecordSchema,
});
const synthesisIndexSchema = v.strictObject({
  pageCount: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  observedSignalKeys: v.array(v.picklist(operationsHealthSignalKeys)),
});

type OuterBehavior = "tool" | "omit_tool" | "provider_error";

export type RuntimeEvaluationObservation = Readonly<{
  plannerPrompts: number;
  investigatorPrompts: number;
  synthesisPrompts: number;
  hypothesisPrompts: number;
  adjudicationPrompts: number;
  invalidObserveCandidateAttempts: number;
  hostilePromptSeen: boolean;
}>;

const parsedEvidencePageSchema = v.pipe(
  v.array(
    v.variant("read", [
      v.object({
        read: v.literal("operations_health"),
        operationId: v.pipe(v.string(), v.minLength(1)),
        snapshot: v.pipe(v.string(), v.minLength(1)),
        data: v.object({
          generatedAt: v.pipe(v.number(), v.safeInteger()),
          signals: v.array(v.object({ key: v.picklist(operationsHealthSignalKeys) })),
        }),
      }),
      v.object({
        read: v.literal("operations_attention"),
        operationId: v.pipe(v.string(), v.minLength(1)),
        snapshot: v.pipe(v.string(), v.minLength(1)),
        data: v.object({
          generatedAt: v.pipe(v.number(), v.safeInteger()),
          items: v.array(
            v.object({
              itemId: v.pipe(v.string(), v.minLength(1)),
              detectorKey: v.pipe(v.string(), v.minLength(1)),
              version: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
            }),
          ),
        }),
      }),
    ]),
  ),
  v.length(1),
);

function userText(context: Context) {
  for (let index = context.messages.length - 1; index >= 0; index -= 1) {
    const message = context.messages[index];
    if (message?.role !== "user") continue;
    return typeof message.content === "string"
      ? message.content
      : message.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
  }
  return "";
}

function jsonSection(text: string, heading: string): unknown {
  const marker = `${heading}\n\n`;
  const start = text.indexOf(marker);
  if (start < 0) throw new Error(`The scripted provider did not find ${heading}.`);
  const valueStart = start + marker.length;
  const sectionEnd = text.indexOf("\n\n", valueStart);
  const serialized = text.slice(valueStart, sectionEnd < 0 ? undefined : sectionEnd).trim();
  return JSON.parse(serialized);
}

function inlineJson(text: string, label: string): unknown {
  const marker = `${label}: `;
  const start = text.indexOf(marker);
  if (start < 0) throw new Error(`The scripted provider did not find ${label}.`);
  const valueStart = start + marker.length;
  const lineEnd = text.indexOf("\n", valueStart);
  return JSON.parse(text.slice(valueStart, lineEnd < 0 ? undefined : lineEnd));
}

class ScriptedAutonomyProvider {
  readonly faux = fauxProvider({
    provider: "openai",
    models: [
      {
        id: operationsIntelligenceModelId,
        name: "Deterministic operations-autonomy evaluation",
        reasoning: true,
      },
    ],
  });

  private readonly outerBehaviors: OuterBehavior[] = [];
  private plannerPrompts = 0;
  private investigatorPrompts = 0;
  private synthesisPrompts = 0;
  private hypothesisPrompts = 0;
  private adjudicationPrompts = 0;
  private invalidObserveCandidateAttempts = 0;
  private hostilePromptSeen = false;
  private invalidCandidatePending = true;

  constructor(private readonly mode: "observe" | "recommend") {
    const response: FauxResponseFactory = (context) => this.respond(context);
    // This finite fixture is a runaway detector for the evaluation. Production
    // autonomy has no corresponding turn or work-item quota.
    this.faux.setResponses(Array.from({ length: 128 }, () => response));
  }

  queueOuterFailure(behavior: Exclude<OuterBehavior, "tool">) {
    // OperationsAutopilot declares two infrastructure attempts. Script both so
    // the durable submission settles and a later work item proves recovery.
    this.outerBehaviors.push(behavior, behavior);
  }

  observation(): RuntimeEvaluationObservation {
    return {
      plannerPrompts: this.plannerPrompts,
      investigatorPrompts: this.investigatorPrompts,
      synthesisPrompts: this.synthesisPrompts,
      hypothesisPrompts: this.hypothesisPrompts,
      adjudicationPrompts: this.adjudicationPrompts,
      invalidObserveCandidateAttempts: this.invalidObserveCandidateAttempts,
      hostilePromptSeen: this.hostilePromptSeen,
    };
  }

  private async respond(context: Context) {
    const prompt = userText(context);
    if (prompt.includes(autonomyEvaluationInjection)) this.hostilePromptSeen = true;
    const toolNames = new Set(context.tools?.map((tool) => tool.name) ?? []);
    if (prompt.includes("# Planning contract")) return this.plannerResponse();
    if (prompt.includes("# Parsed infrastructure-bounded evidence page")) {
      return this.investigatorResponse(prompt);
    }
    if (
      prompt.includes("# Durable hypothesis page") &&
      prompt.includes("# Exact new source records")
    )
      return this.hypothesisResponse(prompt);
    if (prompt.includes("# Exact catalog record pairs")) {
      return this.synthesisResponse(prompt);
    }
    if (prompt.includes("# Adjudication contract")) {
      return this.adjudicationResponse(prompt);
    }
    if (toolNames.has("run_autonomy_work_item") && !toolNames.has("finish")) {
      return this.outerResponse();
    }
    if (!toolNames.has("finish")) {
      throw new Error("The production harness did not mount its structured finish tool.");
    }
    throw new Error("The production runtime invoked an unexpected model prompt.");
  }

  private outerResponse() {
    const behavior = this.outerBehaviors.shift() ?? "tool";
    if (behavior === "omit_tool") {
      return fauxAssistantMessage(fauxText("I will not invoke the required work-item tool."), {
        stopReason: "stop",
      });
    }
    if (behavior === "provider_error") {
      return fauxAssistantMessage([], {
        stopReason: "error",
        errorMessage: "Scripted transient provider failure.",
      });
    }
    return fauxAssistantMessage(fauxToolCall("run_autonomy_work_item", {}), {
      stopReason: "toolUse",
    });
  }

  private plannerResponse() {
    this.plannerPrompts += 1;
    return fauxAssistantMessage(
      fauxToolCall("finish", {
        playbooks: ["health-triage", "attention-hygiene"],
        focusSignalKeys: ["projection_coverage_limited"],
        reads: ["operations_health", "operations_attention"],
      }),
      { stopReason: "toolUse" },
    );
  }

  private async investigatorResponse(prompt: string) {
    this.investigatorPrompts += 1;
    const [page] = v.parse(
      parsedEvidencePageSchema,
      jsonSection(prompt, "# Parsed infrastructure-bounded evidence page"),
    );
    if (page === undefined) throw new Error("The investigator evidence page is missing.");
    const isHealth = page.read === "operations_health";
    const isFinalAttentionPage =
      page.read === "operations_attention" &&
      page.data.items.some((item) => item.itemId === finalAttentionItem.itemId);
    const basicCitations = isHealth
      ? page.data.signals.map((signal) => ({
          read: page.read,
          generatedAt: page.data.generatedAt,
          operationId: page.operationId,
          snapshot: page.snapshot,
          keys: [signal.key],
        }))
      : page.data.items.map((item) => ({
          read: page.read,
          generatedAt: page.data.generatedAt,
          operationId: page.operationId,
          snapshot: page.snapshot,
          keys: [item.itemId, String(item.version)],
        }));
    const target =
      page.read === "operations_attention"
        ? page.data.items.find((item) => item.itemId === finalAttentionItem.itemId)
        : undefined;
    const recommendationCitations =
      target === undefined
        ? basicCitations
        : [
            ...basicCitations,
            {
              read: page.read,
              generatedAt: page.data.generatedAt,
              operationId: page.operationId,
              snapshot: page.snapshot,
              keys: [target.itemId],
            },
          ];
    const finding = {
      statement: isHealth
        ? "The frozen projection reports limited operational coverage."
        : isFinalAttentionPage
          ? "The second frozen attention page contains one current row."
          : "The first attention row contains untrusted instruction-shaped text.",
      uncertainty: "The cited row is operational evidence and does not authorize an action.",
      citations:
        this.mode === "recommend" && isFinalAttentionPage
          ? recommendationCitations
          : basicCitations,
    };
    const shouldAttemptInvalidCandidate =
      this.mode === "observe" && !isHealth && !isFinalAttentionPage && this.invalidCandidatePending;
    if (shouldAttemptInvalidCandidate) {
      this.invalidCandidatePending = false;
      this.invalidObserveCandidateAttempts += 1;
    }
    return fauxAssistantMessage(
      fauxToolCall("finish", {
        area: isHealth ? "system" : "reviews",
        observedSignalKeys: isHealth ? ["projection_coverage_limited"] : [],
        digest: {
          summary: "Every supplied row was examined as untrusted operational evidence.",
          findings: [finding],
          observedSignalKeys: isHealth ? ["projection_coverage_limited"] : [],
        },
        candidates: shouldAttemptInvalidCandidate
          ? [
              {
                statement: "An untrusted model attempted to propose dismissing this item.",
                reasoning: "Observe mode must reject this proposal before any effect boundary.",
                citations: basicCitations,
                arguments: {
                  kind: "dismiss_attention_item",
                  itemId: "attention-first",
                  expectedItemVersion: 3,
                  reason: "This intentionally invalid observe-mode candidate must be rejected.",
                },
              },
            ]
          : this.mode === "recommend" && target !== undefined
            ? [
                {
                  statement:
                    "The exact later-page attention row should be dismissed after human review.",
                  reasoning:
                    "Every row on the frozen page was checked, and the versioned target remains current.",
                  citations: recommendationCitations,
                  arguments: {
                    kind: "dismiss_attention_item",
                    itemId: target.itemId,
                    expectedItemVersion: target.version,
                    reason: "The cited attention item is current and ready for a human decision.",
                  },
                },
              ]
            : [],
        complete: true,
      }),
      { stopReason: "toolUse" },
    );
  }

  private adjudicationResponse(prompt: string) {
    this.adjudicationPrompts += 1;
    const findings = v.parse(
      v.array(autonomyEvidenceRecordSchema),
      inlineJson(prompt, "Finding page"),
    );
    return fauxAssistantMessage(
      fauxToolCall("finish", {
        reviewedFindingRecordIds: findings.map((finding) => finding.recordId),
        decision: "approve",
      }),
      { stopReason: "toolUse" },
    );
  }

  private synthesisResponse(prompt: string) {
    this.synthesisPrompts += 1;
    const indexes = [
      v.parse(synthesisIndexSchema, inlineJson(prompt, "Left index")),
      v.parse(synthesisIndexSchema, inlineJson(prompt, "Right index")),
    ];
    const pairs = v.parse(
      v.array(sourceRecordPairSchema),
      jsonSection(prompt, "# Exact catalog record pairs"),
    );
    const result = v.parse(autonomySynthesisResultSchema, {
      digest: {
        summary: "The exact evidence pairs were exhaustively checked with no added claim.",
        findings: [],
        observedSignalKeys: [...new Set(indexes.flatMap((index) => index.observedSignalKeys))],
      },
      candidates: [],
      reviewedPairIds: pairs.map((pair) => pair.pairId),
      complete: true,
    });
    return fauxAssistantMessage(fauxToolCall("finish", result), { stopReason: "toolUse" });
  }

  private hypothesisResponse(prompt: string) {
    this.hypothesisPrompts += 1;
    const hypotheses = v.parse(
      v.array(hypothesisRecordSchema),
      jsonSection(prompt, "# Durable hypothesis page"),
    );
    const sourceRecords = v.parse(
      v.array(autonomyEvidenceRecordSchema),
      jsonSection(prompt, "# Exact new source records"),
    );
    const result = v.parse(autonomyHypothesisSynthesisResultSchema, {
      digest: {
        summary: "Every durable hypothesis was checked against every exact new source record.",
        findings: [],
        observedSignalKeys: [],
      },
      candidates: [],
      reviewedHypothesisRecordIds: hypotheses.map(({ record }) => record.recordId),
      reviewedSourceRecordIds: [...new Set(sourceRecords.map((record) => record.recordId))],
      complete: true,
    });
    return fauxAssistantMessage(fauxToolCall("finish", result), { stopReason: "toolUse" });
  }
}

type SubmissionResult = "completed" | "failed";

export class AutonomyProductionRuntimeEvaluation {
  readonly input;
  readonly backend;
  readonly provider;

  private flue: Flue | undefined;
  private readonly databasePath: string;
  private readonly disposeInstrumentation: () => Promise<void>;
  private readonly previousBindings = new Map<string, string | undefined>();
  private workIndex = 0;

  constructor(
    private readonly temporaryDirectory: string,
    mode: "observe" | "recommend" = "observe",
  ) {
    this.input = mode === "observe" ? autonomyObserveEvaluationInput() : autonomyEvaluationInput();
    this.backend = new SignedAutonomyEvaluationBackend(mode);
    this.provider = new ScriptedAutonomyProvider(mode);
    this.databasePath = join(temporaryDirectory, "operations-autonomy.sqlite");
    this.disposeInstrumentation = instrument(createAutonomyInstrumentation(this.backend.bindings));
  }

  async start() {
    resetAutonomyEvaluationTerminalEffects();
    await mkdir(this.temporaryDirectory, { recursive: true });
    this.configureBindings();
    this.flue = await start({
      agents: [OperationsAutopilot],
      db: sqlite(this.databasePath),
      providers: [this.provider.faux.provider],
    });
  }

  async coldRestart() {
    await this.stopRuntime();
    clearAutonomyRunForTests(this.input.runId);
    await this.start();
  }

  queueOuterFailure(behavior: "omit_tool" | "provider_error") {
    this.provider.queueOuterFailure(behavior);
  }

  async dispatchInitial() {
    const handle = init(OperationsAutopilot, { id: this.input.runId, uid: null });
    const receipt = await handle.dispatch({
      initialData: this.input,
      idempotencyKey: this.input.runId,
      message: {
        kind: "signal",
        type: "operations.autonomy.run",
        body: "Run the signed authorized operations work item.",
      },
    });
    await handle.read(receipt);
  }

  async dispatchContinuation(): Promise<SubmissionResult> {
    this.workIndex += 1;
    const workItemId = `${this.input.runId}:eval-work:${this.workIndex}`;
    return this.dispatchWorkItem(workItemId);
  }

  async replayCurrentContinuation(): Promise<SubmissionResult> {
    if (this.workIndex < 1) throw new Error("No autonomy continuation is available to replay.");
    return this.dispatchWorkItem(`${this.input.runId}:eval-work:${this.workIndex}`);
  }

  private async dispatchWorkItem(workItemId: string): Promise<SubmissionResult> {
    const handle = init(OperationsAutopilot, { id: this.input.runId });
    const receipt = await handle.dispatch({
      idempotencyKey: workItemId,
      message: {
        kind: "signal",
        type: "operations.autonomy.continue",
        body: "Continue the next authorized operations work item.",
        attributes: { workItemId },
      },
    });
    try {
      await handle.read(receipt);
      return "completed";
    } catch (error) {
      if (error instanceof AgentRunError) return "failed";
      throw error;
    }
  }

  observation() {
    return this.provider.observation();
  }

  terminalEffects() {
    return [...autonomyEvaluationTerminalEffects];
  }

  async stop() {
    await this.stopRuntime();
    await this.disposeInstrumentation();
    clearAutonomyRunForTests(this.input.runId);
    await resetAutonomyEvaluationArtifacts();
    this.restoreBindings();
    await rm(this.temporaryDirectory, { recursive: true, force: true });
  }

  private async stopRuntime() {
    await this.flue?.stop();
    this.flue = undefined;
  }

  private configureBindings() {
    for (const [name, value] of Object.entries(this.backend.bindings)) {
      if (!this.previousBindings.has(name)) {
        this.previousBindings.set(name, process.env[name]);
      }
      process.env[name] = value;
    }
  }

  private restoreBindings() {
    for (const [name, value] of this.previousBindings) {
    if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
    }
    this.previousBindings.clear();
  }
}

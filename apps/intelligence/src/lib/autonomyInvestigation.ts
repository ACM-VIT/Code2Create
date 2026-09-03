import type { FlueHarness, ToolStep } from "@flue/runtime";

import type { AutonomyRunState } from "./autonomyContext.ts";
import {
  investigatorPrompt,
  validateInvestigation,
  type AutonomyReadReceipt,
} from "./autonomyExecution.ts";
import {
  lifecycleDuration,
  type AutonomyLifecycleWriter,
  type AutonomyActiveProgress,
} from "./autonomyLifecycle.ts";
import {
  autonomyInvestigatorResultSchema,
  type OperationsAutonomyInput,
} from "./autonomyProtocol.ts";
import { autonomyOperationId } from "./autonomyOperationId.ts";
import { investigationAreasForPage } from "./autonomyTraversal.ts";
import type { AutonomyEvidenceDigest } from "./autonomyEvidence.ts";
import { authorizeAutonomyWork, type AutonomyBindings } from "./autonomyTransport.ts";

export async function investigateAutonomyPage(args: {
  input: OperationsAutonomyInput;
  state: AutonomyRunState;
  progress: AutonomyActiveProgress;
  workItemId: string;
  receipt: AutonomyReadReceipt;
  area: ReturnType<typeof investigationAreasForPage>[number] | undefined;
  prior?: AutonomyEvidenceDigest;
  harness: FlueHarness;
  step: ToolStep;
  writeLifecycle: AutonomyLifecycleWriter;
  bindings: AutonomyBindings;
  signal?: AbortSignal;
}) {
  const area = args.area;
  if (area === undefined || !investigationAreasForPage(args.receipt).includes(area)) {
    throw new Error("The autonomy investigation area is not present on this evidence page.");
  }
  const index = 0;
  const operationId = await autonomyOperationId("delegation", [
    args.input.runId,
    args.workItemId,
    String(index),
    area,
  ]);
  const startedAt = Date.now();
  args.writeLifecycle({
    operation: "investigate_area",
    phase: "investigating",
    role: "investigator",
    status: "started",
  });
  await args.step.do(`delegation:${index}:${area}`, () =>
    authorizeAutonomyWork({
      state: args.state,
      operationId,
      operation: { kind: "delegation", area },
      bindings: args.bindings,
      ...(args.signal === undefined ? {} : { signal: args.signal }),
    }),
  );
  const investigation = await args.step.do(`investigator:${index}:${area}`, async () => {
    const response = await args.harness.prompt(
      investigatorPrompt({
        input: args.input,
        plan: args.progress.plan,
        area,
        reads: [args.receipt],
        ...(args.prior === undefined ? {} : { priorDigest: args.prior.content }),
      }),
      {
        result: autonomyInvestigatorResultSchema,
        thinkingLevel: "high",
        ...(args.signal === undefined ? {} : { signal: args.signal }),
      },
    );
    return response.data;
  });
  validateInvestigation({
    input: args.input,
    area,
    result: investigation,
    reads: [args.receipt],
  });
  args.writeLifecycle({
    operation: "investigate_area",
    phase: "investigating",
    role: "investigator",
    status: "completed",
    durationMs: lifecycleDuration(startedAt),
  });
  return investigation;
}

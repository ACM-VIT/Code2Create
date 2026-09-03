import type {
  OperationsHealthSeverity,
  OperationsHealthSignal,
  OperationsHealthSnapshot,
} from "@code2create/domain";
import { operationsIntelligenceProtocolVersion } from "@code2create/domain";

import { operationsBriefAgentVersion, operationsBriefModel } from "../agents/operations-brief.ts";
import { buildGroundedOperationsBrief } from "../lib/groundedBrief.ts";
import type { OperationsIntelligenceCallbackBody } from "../protocol.ts";

/** Scores parsed callback structure and membership without matching generated prose. */

export type DeliveredCallback = {
  signatureValid: boolean;
  payload: OperationsIntelligenceCallbackBody;
};

export type BriefRun = {
  briefId: string;
  sourceChecksum: string;
  snapshot: OperationsHealthSnapshot;
  toolCalls: readonly string[];
  toolErrors: readonly string[];
  replyText: string;
  callbacks: readonly DeliveredCallback[];
  malformedCallbacks: readonly string[];
  runError: string | null;
};

const severityRank: Record<OperationsHealthSeverity, number> = {
  watch: 0,
  attention: 1,
  critical: 2,
};

export function contractViolations(run: BriefRun): string[] {
  const violations: string[] = [];
  const report = (violation: string) => violations.push(violation);

  if (run.runError !== null) report(run.runError);
  if (run.toolCalls.length !== 1 || run.toolCalls[0] !== "publish_operations_brief") {
    report(`expected exactly one publish_operations_brief call, saw [${run.toolCalls.join(", ")}]`);
  }
  for (const error of run.toolErrors) report(`tool call failed: ${error}`);
  for (const malformed of run.malformedCallbacks) report(`callback was malformed: ${malformed}`);
  if (run.replyText.trim() !== "") report("answered in prose instead of publishing only");
  const delivered = run.callbacks[0];
  if (delivered === undefined || run.callbacks.length !== 1) {
    report(`expected exactly one delivered callback, saw ${run.callbacks.length}`);
    return violations;
  }
  if (!delivered.signatureValid) report("callback signature did not verify");

  const payload = delivered.payload;
  if (payload.briefId !== run.briefId) report("callback reported a different brief id");
  if (payload.sourceChecksum !== run.sourceChecksum) {
    report("callback reported a different source checksum");
  }
  if (payload.model !== operationsBriefModel) {
    report(`callback reported model ${payload.model}, not ${operationsBriefModel}`);
  }
  if (payload.agentVersion !== operationsBriefAgentVersion) {
    report(`callback reported agent version ${payload.agentVersion}`);
  }
  if (payload.status !== "succeeded") {
    report(`callback settled ${payload.status} (${payload.failureCode})`);
    return violations;
  }

  const signalsByKey = new Map(run.snapshot.signals.map((signal) => [signal.key, signal]));
  if (payload.priorities.length > 3) report("published more than three priorities");

  const citedAcrossPriorities = new Set<string>();
  for (const [index, priority] of payload.priorities.entries()) {
    const label = `priority ${index + 1}`;
    const cited: OperationsHealthSignal[] = [];
    for (const key of priority.signalKeys) {
      const signal = signalsByKey.get(key);
      if (signal === undefined) {
        report(`${label} cited ${key}, which is not in the snapshot`);
        continue;
      }
      cited.push(signal);
      if (citedAcrossPriorities.has(key)) report(`${label} re-cited ${key} from another priority`);
      citedAcrossPriorities.add(key);
    }
    if (new Set(priority.signalKeys).size !== priority.signalKeys.length) {
      report(`${label} cited the same signal key twice`);
    }
    if (cited.length === 0) {
      report(`${label} cited no snapshot signal`);
      continue;
    }
    const highest = cited.reduce((left, right) =>
      severityRank[right.severity] > severityRank[left.severity] ? right : left,
    );
    if (priority.severity !== highest.severity) {
      report(
        `${label} reported severity ${priority.severity}; the highest cited severity is ${highest.severity}`,
      );
    }
    if (
      !cited.some(
        (signal) => signal.owner === priority.owner && signal.nextAction === priority.nextAction,
      )
    ) {
      report(`${label} owner and next action are not copied from the same cited signal`);
    }
  }

  try {
    const expected = buildGroundedOperationsBrief(
      {
        protocolVersion: operationsIntelligenceProtocolVersion,
        briefId: run.briefId,
        sourceChecksum: run.sourceChecksum,
        snapshot: run.snapshot,
      },
      {
        prioritySignalGroups: payload.priorities.map((priority) => priority.signalKeys),
      },
    );
    if (
      JSON.stringify({
        headline: payload.headline,
        summary: payload.summary,
        priorities: payload.priorities,
      }) !== JSON.stringify(expected)
    ) {
      report("published fields differ from the trusted snapshot renderer");
    }
  } catch (error) {
    report(error instanceof Error ? error.message : "trusted brief rendering failed");
  }

  return violations;
}

export function succeededPayload(run: BriefRun) {
  const payload = run.callbacks[0]?.payload;
  return payload !== undefined && payload.status === "succeeded" ? payload : undefined;
}

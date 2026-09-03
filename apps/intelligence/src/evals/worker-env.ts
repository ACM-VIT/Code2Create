/** Resolves evaluation bindings after the local callback server is ready. */

import { resetAutonomyEvaluationArtifacts } from "./autonomy-artifacts.ts";
import type { AutonomyTerminalSettlement } from "../lib/autonomyAdmissionController.ts";
import { deliverAutonomyCallbackPayload } from "../lib/autonomyTransport.ts";

export const autonomyEvaluationTerminalEffects: string[] = [];
const recordedTerminalEffects = new Set<string>();

export function recordAutonomyEvaluationTerminalEffect(effect: string) {
  if (recordedTerminalEffects.has(effect)) return;
  recordedTerminalEffects.add(effect);
  autonomyEvaluationTerminalEffects.push(effect);
}

export function resetAutonomyEvaluationTerminalEffects() {
  autonomyEvaluationTerminalEffects.length = 0;
  recordedTerminalEffects.clear();
}

function binding(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`The intelligence evaluation did not configure ${name}.`);
  }
  return value;
}

export const env = {
  FLUE_OPERATIONS_AUTOPILOT_AGENT: {
    getByName(runId: string) {
      return {
        async requestAutonomyArtifactPurge() {
          recordAutonomyEvaluationTerminalEffect(`purge:${runId}`);
          await resetAutonomyEvaluationArtifacts();
        },
      };
    },
  },
  OPERATIONS_AUTONOMY_ADMISSION_FENCE: {
    getByName(runId: string) {
      return {
        async enqueueTerminalSettlement(settlement: AutonomyTerminalSettlement) {
          recordAutonomyEvaluationTerminalEffect(`settle:${runId}`);
          // The production Durable Object retries this exact operation from its
          // alarm. The deterministic fixture drains one scripted lost response.
          for (;;) {
            try {
              await deliverAutonomyCallbackPayload({
                payload: settlement,
                bindings: env,
              });
              break;
            } catch {
              continue;
            }
          }
        },
      };
    },
  },
  get CONVEX_INTELLIGENCE_CALLBACK_URL(): string {
    return binding("CONVEX_INTELLIGENCE_CALLBACK_URL");
  },
  get CONVEX_INTELLIGENCE_AUTONOMY_CALLBACK_URL(): string {
    return binding("CONVEX_INTELLIGENCE_AUTONOMY_CALLBACK_URL");
  },
  get CONVEX_INTELLIGENCE_AUTONOMY_READ_URL(): string {
    return binding("CONVEX_INTELLIGENCE_AUTONOMY_READ_URL");
  },
  get CONVEX_INTELLIGENCE_AUTONOMY_WORK_URL(): string {
    return binding("CONVEX_INTELLIGENCE_AUTONOMY_WORK_URL");
  },
  get CONVEX_INTELLIGENCE_AUTONOMY_RECOMMENDATION_URL(): string {
    return binding("CONVEX_INTELLIGENCE_AUTONOMY_RECOMMENDATION_URL");
  },
  get CONVEX_INTELLIGENCE_AUTONOMY_RECOMMENDATION_EVIDENCE_URL(): string {
    return binding("CONVEX_INTELLIGENCE_AUTONOMY_RECOMMENDATION_EVIDENCE_URL");
  },
  get INTELLIGENCE_CALLBACK_SECRET(): string {
    return binding("INTELLIGENCE_CALLBACK_SECRET");
  },
  get INTELLIGENCE_READ_SECRET(): string {
    return binding("INTELLIGENCE_READ_SECRET");
  },
};

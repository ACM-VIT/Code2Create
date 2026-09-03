import { SubmissionConflictError, type DispatchReceipt } from "@flue/runtime";

import type { OperationsAutonomyCallback, OperationsHealthSignalKey } from "@code2create/domain";

import type {
  OperationsAutonomyInput,
  OperationsAutonomyContinuationInput,
  OperationsAutonomyAbortInput,
} from "./autonomyProtocol.ts";

export type AutonomyTerminalSettlement = OperationsAutonomyCallback & {
  status: "succeeded" | "no_op" | "escalated";
  phase: "terminal";
  observedSignalKeys: OperationsHealthSignalKey[];
};

export type AutonomyAdmissionResult =
  | { state: "accepted"; receipt: DispatchReceipt }
  | { state: "conflict"; submissionId?: string }
  | { state: "revoked" }
  | { state: "unavailable" };

export type AutonomyAbortResult = { state: "accepted" } | { state: "pending" };

export type AutonomyAdmissionControllerDebugState = {
  revoked: boolean;
  pending: number;
  settled: number;
  abortRecorded: boolean;
};

export type AutonomyAdmissionController = {
  admitInitial(input: OperationsAutonomyInput): Promise<AutonomyAdmissionResult>;
  admitContinuation(input: OperationsAutonomyContinuationInput): Promise<AutonomyAdmissionResult>;
  revoke(input: OperationsAutonomyAbortInput): Promise<AutonomyAbortResult>;
  enqueueTerminalSettlement(settlement: AutonomyTerminalSettlement): Promise<void>;
  debugState?(): Promise<AutonomyAdmissionControllerDebugState>;
};

export type AutonomyAdmissionControllerNamespace = {
  getByName(runId: string): AutonomyAdmissionController;
};

export function admissionControllerForRun(
  bindings: Pick<Cloudflare.Env, "OPERATIONS_AUTONOMY_ADMISSION_FENCE">,
  runId: string,
) {
  return bindings.OPERATIONS_AUTONOMY_ADMISSION_FENCE.getByName(runId);
}

type MemoryOperations = {
  dispatchInitial(input: OperationsAutonomyInput): Promise<DispatchReceipt>;
  dispatchContinuation(input: OperationsAutonomyContinuationInput): Promise<DispatchReceipt>;
  abort(): Promise<void>;
};

type MemoryAdmission = {
  payload: string;
  result?: AutonomyAdmissionResult;
};

/** Environment-neutral controller used by route and race regressions. */
export function memoryAutonomyAdmissionController(
  operations: MemoryOperations,
): AutonomyAdmissionController {
  const admissions = new Map<string, MemoryAdmission>();
  const active = new Map<string, Promise<AutonomyAdmissionResult>>();
  let revoked = false;
  let abortRecorded = false;

  const admit = async (
    operationId: string,
    payload: string,
    dispatch: () => Promise<DispatchReceipt>,
  ): Promise<AutonomyAdmissionResult> => {
    if (revoked) return { state: "revoked" };
    const existing = admissions.get(operationId);
    if (existing !== undefined && existing.payload !== payload) {
      return { state: "conflict" };
    }
    if (existing?.result !== undefined) return existing.result;
    if (existing === undefined) admissions.set(operationId, { payload });
    const running = active.get(operationId);
    if (running !== undefined) return running;
    const operation = (async () => {
      try {
        const receipt = await dispatch();
        const result = { state: "accepted" as const, receipt };
        admissions.set(operationId, { payload, result });
        if (revoked && !abortRecorded) {
          await operations.abort();
          abortRecorded = true;
        }
        return result;
      } catch (error) {
        if (error instanceof SubmissionConflictError) {
          const result = {
            state: "conflict" as const,
            submissionId: error.submissionId,
          };
          admissions.set(operationId, { payload, result });
          return result;
        }
        return { state: "unavailable" as const };
      } finally {
        active.delete(operationId);
      }
    })();
    active.set(operationId, operation);
    return operation;
  };

  return {
    admitInitial(input) {
      return admit(`initial:${input.runId}`, JSON.stringify(input), () =>
        operations.dispatchInitial(input),
      );
    },
    admitContinuation(input) {
      return admit(input.operationId, JSON.stringify(input), () =>
        operations.dispatchContinuation(input),
      );
    },
    async revoke() {
      revoked = true;
      if ([...admissions.values()].some((admission) => admission.result === undefined)) {
        return { state: "pending" };
      }
      if (!abortRecorded) {
        try {
          await operations.abort();
        } catch {
          // A durable revocation with no admitted instance is already complete.
        }
        abortRecorded = true;
      }
      admissions.clear();
      return { state: "accepted" };
    },
    async enqueueTerminalSettlement() {
      revoked = true;
      admissions.clear();
    },
    async debugState() {
      return {
        revoked,
        pending: [...admissions.values()].filter((admission) => admission.result === undefined)
          .length,
        settled: [...admissions.values()].filter((admission) => admission.result !== undefined)
          .length,
        abortRecorded,
      };
    },
  };
}

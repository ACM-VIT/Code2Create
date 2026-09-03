import {
  AgentInstanceNotFoundError,
  AgentRunError,
  SubmissionConflictError,
  init,
} from "@flue/runtime";

import { OperationsAutopilot } from "../agents/operations-autopilot.ts";
import { deliverAutonomyCallbackPayload } from "./autonomyTransport.ts";
import {
  AutonomyAdmissionFenceState,
  type AutonomyFenceAdmissionRequest,
} from "./autonomyAdmissionFenceState.ts";
import type { AutonomyTerminalSettlement } from "./autonomyAdmissionController.ts";

export class OperationsAutonomyAdmissionFence extends AutonomyAdmissionFenceState<Cloudflare.Env> {
  protected async dispatchAdmission(
    request: AutonomyFenceAdmissionRequest,
    mayDispatch: () => Promise<boolean>,
  ) {
    const handle = init(OperationsAutopilot, { id: request.payload.runId });
    if (request.kind === "initial") {
      if (!(await mayDispatch())) return undefined;
      return handle.dispatch({
        initialData: request.payload,
        idempotencyKey: request.payload.runId,
        message: {
          kind: "signal",
          type: "operations.autonomy.run",
          body: "Run the signed authorized operations work item.",
        },
      });
    }
    try {
      await handle.read(request.payload.priorSubmissionId);
    } catch (error) {
      if (!(error instanceof AgentRunError)) throw error;
    }
    if (!(await mayDispatch())) return undefined;
    return handle.dispatch({
      idempotencyKey: request.payload.workItemId,
      message: {
        kind: "signal",
        type: "operations.autonomy.continue",
        body: "Continue the next authorized operations work item.",
        attributes: {
          operationId: request.payload.operationId,
          workItemId: request.payload.workItemId,
        },
      },
    });
  }

  protected async abortRun(runId: string) {
    try {
      await init(OperationsAutopilot, { id: runId }).abort();
      return "accepted" as const;
    } catch (error) {
      if (error instanceof AgentInstanceNotFoundError) return "not_found" as const;
      throw error;
    }
  }

  protected async deliverTerminalSettlement(settlement: AutonomyTerminalSettlement) {
    await deliverAutonomyCallbackPayload({
      payload: settlement,
      bindings: this.env,
    });
  }

  protected dispatchConflict(error: unknown) {
    return error instanceof SubmissionConflictError
      ? { submissionId: error.submissionId }
      : undefined;
  }
}

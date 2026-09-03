import {
  operationsHealthSignalKeys,
  operationsIntelligenceProtocolVersion,
} from "@code2create/domain";
import { DurableObject } from "cloudflare:workers";
import * as v from "valibot";

import {
  operationsAutonomyAbortRequestSchema,
  operationsAutonomyContinuationRequestSchema,
  operationsAutonomyDispatchRequestSchema,
  type OperationsAutonomyAbortInput,
  type OperationsAutonomyContinuationInput,
  type OperationsAutonomyInput,
} from "./autonomyProtocol.ts";
import type {
  AutonomyAbortResult,
  AutonomyAdmissionResult,
  AutonomyTerminalSettlement,
} from "./autonomyAdmissionController.ts";

const reconcileDelayMs = 1_000;
const settledCleanupPageSize = 64;
const fingerprintSchema = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/u));
const operationIdSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(240),
  v.regex(/^[A-Za-z0-9][A-Za-z0-9:._-]*$/u),
);
const receiptSchema = v.strictObject({
  submissionId: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  acceptedAt: v.pipe(v.string(), v.isoTimestamp()),
  uid: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  deduplicated: v.optional(v.literal(true)),
});
const initialAdmissionSchema = v.strictObject({
  kind: v.literal("initial"),
  operationId: operationIdSchema,
  payload: operationsAutonomyDispatchRequestSchema,
});
const continuationAdmissionSchema = v.strictObject({
  kind: v.literal("continuation"),
  operationId: operationIdSchema,
  payload: operationsAutonomyContinuationRequestSchema,
});
const admissionRequestSchema = v.variant("kind", [
  initialAdmissionSchema,
  continuationAdmissionSchema,
]);
const pendingAdmissionSchema = v.strictObject({
  state: v.literal("pending"),
  fingerprint: fingerprintSchema,
  request: admissionRequestSchema,
});
const acceptedAdmissionSchema = v.strictObject({
  state: v.literal("accepted"),
  fingerprint: fingerprintSchema,
  receipt: receiptSchema,
});
const conflictAdmissionSchema = v.strictObject({
  state: v.literal("conflict"),
  fingerprint: fingerprintSchema,
  submissionId: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(200))),
});
const admissionSchema = v.variant("state", [
  pendingAdmissionSchema,
  acceptedAdmissionSchema,
  conflictAdmissionSchema,
]);
const terminalSettlementSchema = v.strictObject({
  protocolVersion: v.literal(operationsIntelligenceProtocolVersion),
  runId: v.pipe(v.string(), v.minLength(1), v.maxLength(240)),
  policyVersionId: v.pipe(v.string(), v.minLength(1), v.maxLength(240)),
  policyChecksum: fingerprintSchema,
  sourceChecksum: fingerprintSchema,
  operationId: operationIdSchema,
  status: v.picklist(["succeeded", "no_op", "escalated"]),
  phase: v.literal("terminal"),
  observedSignalKeys: v.pipe(
    v.array(v.picklist(operationsHealthSignalKeys)),
    v.maxLength(operationsHealthSignalKeys.length),
  ),
  agentVersion: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  model: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
});

type Admission = v.InferOutput<typeof admissionSchema>;
export type AutonomyFenceAdmissionRequest = v.InferOutput<typeof admissionRequestSchema>;
export type AutonomyFenceDispatchReceipt = v.InferOutput<typeof receiptSchema>;

function admissionKey(operationId: string) {
  return `admission:${operationId}`;
}

function pendingKey(operationId: string) {
  return `pending:${operationId}`;
}

async function admissionFingerprint(request: AutonomyFenceAdmissionRequest) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(request)),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function admissionResult(admission: Admission): AutonomyAdmissionResult | undefined {
  if (admission.state === "accepted") {
    return {
      state: "accepted",
      receipt: {
        submissionId: admission.receipt.submissionId,
        acceptedAt: admission.receipt.acceptedAt,
        uid: admission.receipt.uid,
        ...(admission.receipt.deduplicated === true ? { deduplicated: true } : {}),
      },
    };
  }
  if (admission.state === "conflict") {
    return {
      state: "conflict",
      ...(admission.submissionId === undefined ? {} : { submissionId: admission.submissionId }),
    };
  }
  return undefined;
}

/**
 * Run-serialized durable admission state machine. Subclasses only supply the
 * Flue dispatch and abort effects; all revocation, persistence, recovery, and
 * alarm ordering stays here and is exercised in a real workerd DO test.
 */
export abstract class AutonomyAdmissionFenceState<Env> extends DurableObject<Env> {
  readonly #active = new Map<string, Promise<AutonomyAdmissionResult>>();

  protected abstract dispatchAdmission(
    request: AutonomyFenceAdmissionRequest,
    mayDispatch: () => Promise<boolean>,
  ): Promise<AutonomyFenceDispatchReceipt | undefined>;

  protected abstract abortRun(runId: string): Promise<"accepted" | "not_found">;

  protected abstract deliverTerminalSettlement(
    settlement: AutonomyTerminalSettlement,
  ): Promise<void>;

  async admitInitial(value: OperationsAutonomyInput) {
    const input = v.parse(operationsAutonomyDispatchRequestSchema, value);
    return this.#admit({
      kind: "initial",
      operationId: `initial:${input.runId}`,
      payload: input,
    });
  }

  async admitContinuation(value: OperationsAutonomyContinuationInput) {
    const input = v.parse(operationsAutonomyContinuationRequestSchema, value);
    return this.#admit({
      kind: "continuation",
      operationId: input.operationId,
      payload: input,
    });
  }

  async revoke(value: OperationsAutonomyAbortInput): Promise<AutonomyAbortResult> {
    const input = v.parse(operationsAutonomyAbortRequestSchema, value);
    await this.#bindRun(input.runId);
    await this.ctx.storage.put("revoked", true);
    await this.ctx.storage.delete(["terminalPending", "terminalSettlement"]);
    if (await this.#hasPendingAdmission()) {
      await this.#scheduleReconciliation();
      return { state: "pending" };
    }
    const abort = await this.#recordAbort(input.runId, true);
    if (abort.state === "accepted") await this.#closeFence();
    return abort;
  }

  /**
   * Persists the exact terminal callback before attempting it. Alarms replay
   * the same signed operation across isolate loss; admission closes only after
   * the backend receipt is durable, so neither ordering can wedge recovery.
   */
  async enqueueTerminalSettlement(value: AutonomyTerminalSettlement) {
    const settlement = v.parse(terminalSettlementSchema, value);
    await this.#bindRun(settlement.runId);
    const queued = await this.ctx.storage.transaction(async (transaction) => {
      if ((await transaction.get<boolean>("revoked")) === true) return false;
      const existing = await transaction.get<AutonomyTerminalSettlement>("terminalSettlement");
      if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(settlement)) {
        throw new Error("The autonomy terminal settlement changed after it was queued.");
      }
      if (existing === undefined) await transaction.put("terminalSettlement", settlement);
      await transaction.put("terminalPending", true);
      await transaction.setAlarm(Date.now() + reconcileDelayMs);
      return true;
    });
    if (!queued) return;
    await this.#drainTerminalSettlement();
  }

  override async alarm() {
    const runId = await this.ctx.storage.get<string>("runId");
    if (runId === undefined) return;
    if ((await this.ctx.storage.get<boolean>("terminalPending")) === true) {
      await this.#drainTerminalSettlement();
      if ((await this.ctx.storage.get<boolean>("terminalPending")) === true) return;
    }
    if ((await this.ctx.storage.get<boolean>("closed")) === true) {
      await this.#deleteAdmissionPage();
      return;
    }
    const revoked = (await this.ctx.storage.get<boolean>("revoked")) === true;
    const pending = await this.ctx.storage.list<string>({ prefix: "pending:", limit: 1 });
    for (const operationId of pending.values()) {
      if (revoked) {
        if (this.#active.has(operationId)) {
          await this.#scheduleReconciliation();
          break;
        }
        // A cold pending row has no surviving physical Promise. The durable
        // revoked fence makes re-admission impossible, so not-found is a
        // conclusive recorded abort intent and the stale row can be removed.
        const abort = await this.#recordAbort(runId, true);
        if (abort.state === "accepted") {
          await this.ctx.storage.delete([pendingKey(operationId), admissionKey(operationId)]);
        } else {
          await this.#scheduleReconciliation();
        }
        break;
      }
      const value = await this.ctx.storage.get<Admission>(admissionKey(operationId));
      if (value === undefined) throw new Error("A pending autonomy admission is missing.");
      const admission = v.parse(admissionSchema, value);
      if (admission.state !== "pending") {
        await this.ctx.storage.delete(pendingKey(operationId));
        continue;
      }
      await this.#trackedResume(admission);
      break;
    }
    if (await this.#hasPendingAdmission()) await this.#scheduleReconciliation();
    if (revoked && !(await this.#hasPendingAdmission())) {
      const abort = await this.#recordAbort(runId, true);
      if (abort.state === "accepted") await this.#closeFence();
    }
  }

  async #admit(requestValue: AutonomyFenceAdmissionRequest): Promise<AutonomyAdmissionResult> {
    const request = v.parse(admissionRequestSchema, requestValue);
    await this.#bindRun(request.payload.runId);
    const fingerprint = await admissionFingerprint(request);
    const prepared = await this.ctx.storage.transaction(async (transaction) => {
      if (
        (await transaction.get<boolean>("revoked")) === true ||
        (await transaction.get<boolean>("terminalPending")) === true
      ) {
        return { state: "revoked" as const };
      }
      const existingValue = await transaction.get<Admission>(admissionKey(request.operationId));
      if (existingValue !== undefined) {
        const existing = v.parse(admissionSchema, existingValue);
        if (existing.fingerprint !== fingerprint) return { state: "conflict" as const };
        return { state: "existing" as const, admission: existing };
      }
      const admission = v.parse(pendingAdmissionSchema, {
        state: "pending",
        fingerprint,
        request,
      });
      await transaction.put(admissionKey(request.operationId), admission);
      await transaction.put(pendingKey(request.operationId), request.operationId);
      return { state: "existing" as const, admission };
    });
    if (prepared.state === "revoked") return { state: "revoked" };
    if (prepared.state === "conflict") return { state: "conflict" };
    const settled = admissionResult(prepared.admission);
    if (settled !== undefined) return settled;
    if (prepared.admission.state !== "pending") {
      throw new Error("A settled autonomy admission has no public result.");
    }
    return this.#trackedResume(prepared.admission);
  }

  #trackedResume(
    admission: v.InferOutput<typeof pendingAdmissionSchema>,
  ): Promise<AutonomyAdmissionResult> {
    const operationId = admission.request.operationId;
    const active = this.#active.get(operationId);
    if (active !== undefined) return active;
    const operation = this.#resume(admission).finally(() => {
      this.#active.delete(operationId);
    });
    this.#active.set(operationId, operation);
    this.ctx.waitUntil(
      operation.then(
        () => undefined,
        () => undefined,
      ),
    );
    return operation;
  }

  async #resume(
    admission: v.InferOutput<typeof pendingAdmissionSchema>,
  ): Promise<AutonomyAdmissionResult> {
    if ((await this.ctx.storage.get<boolean>("revoked")) === true) {
      const abort = await this.#recordAbort(admission.request.payload.runId, true);
      if (abort.state === "accepted") {
        await this.ctx.storage.delete([
          pendingKey(admission.request.operationId),
          admissionKey(admission.request.operationId),
        ]);
      } else {
        await this.#scheduleReconciliation();
      }
      return { state: "revoked" };
    }
    await this.#scheduleReconciliation();
    try {
      const receipt = await this.dispatchAdmission(admission.request, () =>
        this.#mayDispatch(admission.request.operationId),
      );
      if (receipt === undefined) {
        const abort = await this.#recordAbort(admission.request.payload.runId, true);
        if (abort.state === "accepted") {
          await this.ctx.storage.delete([
            pendingKey(admission.request.operationId),
            admissionKey(admission.request.operationId),
          ]);
        }
        return { state: "revoked" };
      }
      const accepted = v.parse(acceptedAdmissionSchema, {
        state: "accepted",
        fingerprint: admission.fingerprint,
        receipt,
      });
      await this.ctx.storage.put(admissionKey(admission.request.operationId), accepted);
      await this.ctx.storage.delete(pendingKey(admission.request.operationId));
      if ((await this.ctx.storage.get<boolean>("revoked")) === true) {
        await this.#recordAbort(admission.request.payload.runId, true);
      }
      const acceptedResult = admissionResult(accepted);
      if (acceptedResult === undefined) {
        throw new Error("An accepted autonomy admission has no public result.");
      }
      return acceptedResult;
    } catch (error) {
      const conflict = this.dispatchConflict(error);
      if (conflict !== undefined) {
        const settled = v.parse(conflictAdmissionSchema, {
          state: "conflict",
          fingerprint: admission.fingerprint,
          ...(conflict.submissionId === undefined ? {} : { submissionId: conflict.submissionId }),
        });
        await this.ctx.storage.put(admissionKey(admission.request.operationId), settled);
        await this.ctx.storage.delete(pendingKey(admission.request.operationId));
        if ((await this.ctx.storage.get<boolean>("revoked")) === true) {
          await this.#recordAbort(admission.request.payload.runId, true);
        }
        return admissionResult(settled) ?? { state: "conflict" };
      }
      await this.#scheduleReconciliation();
      return { state: "unavailable" };
    }
  }

  protected abstract dispatchConflict(error: unknown): { submissionId?: string } | undefined;

  async #recordAbort(runId: string, allowNotFound: boolean): Promise<AutonomyAbortResult> {
    if ((await this.ctx.storage.get<boolean>("abortRecorded")) === true) {
      return { state: "accepted" };
    }
    try {
      const result = await this.abortRun(runId);
      if (result === "not_found" && !allowNotFound) {
        await this.#scheduleReconciliation();
        return { state: "pending" };
      }
    } catch {
      await this.#scheduleReconciliation();
      return { state: "pending" };
    }
    await this.ctx.storage.put("abortRecorded", true);
    return { state: "accepted" };
  }

  async #mayDispatch(operationId: string) {
    if ((await this.ctx.storage.get<boolean>("revoked")) === true) return false;
    return (await this.ctx.storage.get(pendingKey(operationId))) !== undefined;
  }

  async #bindRun(runId: string) {
    await this.ctx.storage.transaction(async (transaction) => {
      const existing = await transaction.get<string>("runId");
      if (existing !== undefined && existing !== runId) {
        throw new Error("An autonomy admission controller cannot change run identity.");
      }
      if (existing === undefined) await transaction.put("runId", runId);
    });
  }

  async #hasPendingAdmission() {
    return (await this.ctx.storage.list({ prefix: "pending:", limit: 1 })).size !== 0;
  }

  async #scheduleReconciliation() {
    await this.#scheduleAt(Date.now() + reconcileDelayMs);
  }

  async #scheduleAt(timestamp: number) {
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null || timestamp < existing) {
      await this.ctx.storage.setAlarm(timestamp);
    }
  }

  async #drainTerminalSettlement() {
    const stored = await this.ctx.storage.get<AutonomyTerminalSettlement>("terminalSettlement");
    if (stored === undefined) {
      await this.ctx.storage.delete("terminalPending");
      return;
    }
    const settlement = v.parse(terminalSettlementSchema, stored);
    // Pre-arm the next replay before external I/O. An isolate can disappear at
    // any await point without running a catch/finally block.
    await this.#scheduleReconciliation();
    try {
      await this.deliverTerminalSettlement(settlement);
    } catch {
      await this.#scheduleReconciliation();
      return;
    }
    await this.#closeFence();
  }

  async #closeFence() {
    // Callback acceptance and fence closure are one durable transition. If the
    // isolate disappears afterward, admission is already impossible even when
    // the bounded receipt cleanup has not finished yet.
    await this.ctx.storage.transaction(async (transaction) => {
      await transaction.put({ revoked: true, closed: true });
      await transaction.delete(["terminalPending", "terminalSettlement"]);
    });
    await this.#deleteAdmissionPage();
  }

  async #deleteAdmissionPage() {
    const admissions = await this.ctx.storage.list({
      prefix: "admission:",
      limit: settledCleanupPageSize,
    });
    if (admissions.size !== 0) {
      await this.ctx.storage.delete([...admissions.keys()]);
    }
    const pending = await this.ctx.storage.list({
      prefix: "pending:",
      limit: settledCleanupPageSize,
    });
    if (pending.size !== 0) await this.ctx.storage.delete([...pending.keys()]);
    if (
      (await this.ctx.storage.list({ prefix: "admission:", limit: 1 })).size !== 0 ||
      (await this.ctx.storage.list({ prefix: "pending:", limit: 1 })).size !== 0
    )
      await this.#scheduleReconciliation();
  }
}

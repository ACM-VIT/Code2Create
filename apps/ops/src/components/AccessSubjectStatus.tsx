import { api } from "@code2create/backend/api";
import type { FunctionReturnType } from "convex/server";
import { useMutation } from "convex/react";
import { useState, type SubmitEvent } from "react";

import { AccessManagementDisclosure } from "./AccessManagementDisclosure";
import { eventSlug } from "../lib/config";
import { readableError } from "../lib/errors";
import { useOperationRunner } from "../lib/operations";

type AccessDetail = NonNullable<FunctionReturnType<typeof api.access.detail>>;
type ManagedStatus = Extract<AccessDetail["person"]["status"], "active" | "suspended">;

export function AccessSubjectStatus({
  personId,
  status,
  accessVersion,
  effectiveGrantCount,
}: {
  personId: AccessDetail["person"]["id"];
  status: ManagedStatus;
  accessVersion: number;
  effectiveGrantCount: number;
}) {
  const suspend = useMutation(api.accessSubjects.suspend);
  const reactivate = useMutation(api.accessSubjects.reactivate);
  const operations = useOperationRunner();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const suspendPending = operations.hasPending("access-suspend");
  const restorePending = operations.hasPending("access-restore");
  const operationPending = suspendPending || restorePending;
  const isSuspending = suspendPending || (!restorePending && status === "active");
  const actionLabel = isSuspending ? "Suspend account" : "Reactivate account";
  const busyLabel = isSuspending ? "Suspending…" : "Reactivating…";

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await operations.run(
        isSuspending ? "access-suspend" : "access-restore",
        (clientOperationId) => () => {
          const request = {
            eventSlug,
            targetPersonId: personId,
            expectedAccessVersion: accessVersion,
            reason,
            clientOperationId,
          };
          return isSuspending ? suspend(request) : reactivate(request);
        },
      );
      setReason("");
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AccessManagementDisclosure
      description={
        isSuspending
          ? `Immediately block ${effectiveGrantCount} current permission${effectiveGrantCount === 1 ? "" : "s"}.`
          : `Restore ${effectiveGrantCount} current permission${effectiveGrantCount === 1 ? "" : "s"}.`
      }
      title={isSuspending ? "Suspend event account" : "Reactivate event account"}
      tone={isSuspending ? "danger" : "default"}
    >
      <form className="role-form" onSubmit={submit}>
        <label className="field">
          <span>
            {isSuspending ? "Why access is being suspended" : "Why access is being restored"}
          </span>
          <textarea
            required
            disabled={busy || operationPending}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
        <div className="role-submit">
          <button
            className="secondary"
            type="submit"
            disabled={busy || (!operationPending && reason.trim().length < 5)}
          >
            {busy
              ? busyLabel
              : operationPending
                ? `Confirm earlier ${isSuspending ? "suspension" : "reactivation"}`
                : actionLabel}
          </button>
          <small>You may be asked to sign in again before this change.</small>
        </div>
      </form>
      {error ? (
        <p className="notice error" role="alert">
          {error}
        </p>
      ) : null}
    </AccessManagementDisclosure>
  );
}

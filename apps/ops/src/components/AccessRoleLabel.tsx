import { api } from "@code2create/backend/api";
import { eventRoleLabels } from "@code2create/domain";
import type { FunctionReturnType } from "convex/server";
import { useMutation } from "convex/react";
import { useState, type SubmitEvent } from "react";

import { AccessManagementDisclosure } from "./AccessManagementDisclosure";
import { eventSlug } from "../lib/config";
import { readableError } from "../lib/errors";
import { useOperationRunner } from "../lib/operations";

type AccessDetail = NonNullable<FunctionReturnType<typeof api.access.detail>>;
type EventRole = Exclude<AccessDetail["person"]["role"], undefined>;

const roleOptions: readonly EventRole[] = ["supreme", "board", "sc", "jc", "external_judge"];

export function AccessRoleLabel({
  personId,
  currentRole,
  accessVersion,
  canGrantAny,
  canRevokeAny,
}: {
  personId: AccessDetail["person"]["id"];
  currentRole: EventRole | undefined;
  accessVersion: number;
  canGrantAny: boolean;
  canRevokeAny: boolean;
}) {
  const setRole = useMutation(api.accessRoles.set);
  const operations = useOperationRunner();
  const [selectedRole, setSelectedRole] = useState<EventRole | "">(currentRole ?? "");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rolePending = operations.hasPending("access-role-set");
  const synchronizingSupreme = currentRole === "supreme" && selectedRole === "supreme";
  const roleCeilingAllowsChange =
    (selectedRole !== "supreme" || canGrantAny) &&
    (currentRole !== "supreme" || selectedRole === "supreme" || canRevokeAny);

  const selectRole = (value: string) => {
    if (!value) {
      setSelectedRole("");
      return;
    }
    const role = roleOptions.find((candidate) => candidate === value);
    if (role) setSelectedRole(role);
  };

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await operations.run(
        "access-role-set",
        (clientOperationId) => () =>
          setRole({
            eventSlug,
            targetPersonId: personId,
            role: selectedRole || null,
            expectedAccessVersion: accessVersion,
            reason,
            clientOperationId,
          }),
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
        currentRole === "supreme"
          ? "Supreme includes every event-wide permission and the account’s own reviewer permissions."
          : `Currently ${currentRole ? eventRoleLabels[currentRole] : "no role"}. Permissions granted one by one are handled separately.`
      }
      title="Change role"
    >
      <form className="role-form" onSubmit={submit}>
        <label className="field">
          <span>Role</span>
          <select
            disabled={busy || rolePending}
            value={selectedRole}
            onChange={(event) => selectRole(event.target.value)}
          >
            <option value="">No role</option>
            {roleOptions.map((role) => (
              <option disabled={role === "supreme" && !canGrantAny} key={role} value={role}>
                {eventRoleLabels[role]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>
            {synchronizingSupreme
              ? "Why Supreme access is being synchronized"
              : "Why this role is changing"}
          </span>
          <textarea
            required
            disabled={busy || rolePending}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
        <div className="role-submit">
          <button
            className="secondary"
            type="submit"
            disabled={
              busy ||
              (!rolePending &&
                (!roleCeilingAllowsChange ||
                  reason.trim().length < 5 ||
                  (selectedRole === (currentRole ?? "") && !synchronizingSupreme)))
            }
          >
            {busy
              ? "Saving…"
              : rolePending
                ? "Confirm earlier role change"
                : synchronizingSupreme
                  ? "Synchronize Supreme access"
                  : "Save role"}
          </button>
          <small>
            {roleCeilingAllowsChange
              ? "You may be asked to sign in again before this change."
              : "You cannot grant everything this role changes."}
          </small>
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

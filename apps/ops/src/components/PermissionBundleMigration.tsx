import { api } from "@code2create/backend/api";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { useState, type SubmitEvent } from "react";

import { BundleBindingField } from "./BundleBindingField";
import { eventSlug } from "../lib/config";
import { readableError } from "../lib/errors";
import { useMutationAttempt } from "../lib/operations";
import { permissionName, scopeName } from "../lib/permissionLabels";

type BundleId = FunctionArgs<typeof api.permissionBundleMigrations.sources>["bundleId"];
type SourceVersionId = FunctionArgs<
  typeof api.permissionBundleMigrations.preview
>["sourceBundleVersionId"];
type PreviewSelection = FunctionArgs<
  typeof api.permissionBundleMigrations.preview
>["selections"][number];
type PreviewRequest = {
  sourceBundleVersionId: SourceVersionId;
  selections: PreviewSelection[];
};
type Candidate = FunctionReturnType<
  typeof api.permissionBundleMigrations.candidates
>["page"][number];
type Change = FunctionReturnType<
  typeof api.permissionBundleMigrations.preview
>["targets"][number]["changes"][number];

const maximumTargets = 5;

export function PermissionBundleMigration({ bundleId }: { bundleId: BundleId }) {
  const sourceVersions = usePaginatedQuery(
    api.permissionBundleMigrations.sources,
    { eventSlug, bundleId },
    { initialNumItems: 10 },
  );
  const migrate = useMutation(api.permissionBundleMigrations.confirm);
  const [sourceVersionId, setSourceVersionId] = useState<SourceVersionId | null>(null);
  const [selections, setSelections] = useState<PreviewSelection[]>([]);
  const [previewRequest, setPreviewRequest] = useState<PreviewRequest | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const migrationAttempt =
    useMutationAttempt<FunctionReturnType<typeof api.permissionBundleMigrations.confirm>>();
  const migrationPending = migrationAttempt.hasPending("permission-bundle-migration");
  const candidates = usePaginatedQuery(
    api.permissionBundleMigrations.candidates,
    sourceVersionId ? { eventSlug, sourceBundleVersionId: sourceVersionId } : "skip",
    { initialNumItems: 5 },
  );
  const preview = useQuery(
    api.permissionBundleMigrations.preview,
    previewRequest ? { eventSlug, ...previewRequest } : "skip",
  );

  const resetPreview = () => {
    if (migrationPending) return;
    setPreviewRequest(null);
    setMessage(null);
    setError(null);
  };

  const chooseSourceVersion = (value: string) => {
    const selected = sourceVersions.results.find((version) => version.id === value);
    setSourceVersionId(selected?.id ?? null);
    setSelections([]);
    resetPreview();
  };

  const toggleCandidate = (candidate: Candidate, checked: boolean) => {
    setSelections((current) => {
      if (!checked) {
        return current.filter(
          (selection) => selection.sourceGrantBatchId !== candidate.sourceGrantBatchId,
        );
      }
      if (
        current.length >= maximumTargets ||
        current.some((selection) => selection.sourceGrantBatchId === candidate.sourceGrantBatchId)
      ) {
        return current;
      }
      return [
        ...current,
        {
          sourceGrantBatchId: candidate.sourceGrantBatchId,
          bindings: candidate.bindings.map((binding) => ({
            key: binding.key,
            scopeId: binding.suggestedScopeId ?? "",
          })),
        },
      ];
    });
    resetPreview();
  };

  const updateBinding = (
    sourceGrantBatchId: PreviewSelection["sourceGrantBatchId"],
    key: string,
    scopeId: string,
  ) => {
    setSelections((current) =>
      current.map((selection) =>
        selection.sourceGrantBatchId === sourceGrantBatchId
          ? {
              ...selection,
              bindings: selection.bindings.map((binding) =>
                binding.key === key ? { ...binding, scopeId } : binding,
              ),
            }
          : selection,
      ),
    );
    resetPreview();
  };

  const requestPreview = (event: SubmitEvent) => {
    event.preventDefault();
    if (!sourceVersionId || selections.length === 0 || !bindingsComplete(selections)) return;
    if (migrationPending) return;
    setError(null);
    setMessage(null);
    setPreviewRequest({ sourceBundleVersionId: sourceVersionId, selections });
  };

  const confirmMigration = async () => {
    if (!migrationPending && (!preview || !previewRequest)) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await migrationAttempt.run("permission-bundle-migration", () => {
        if (!preview || !previewRequest) {
          throw new Error("The migration preview is no longer available.");
        }
        const selections = previewRequest.selections.map((selection) => {
          const target = preview.targets.find(
            (candidate) => candidate.sourceGrantBatchId === selection.sourceGrantBatchId,
          );
          if (!target)
            throw new Error("The migration preview no longer matches the selected people.");
          return { ...selection, expectedAccessVersion: target.expectedAccessVersion };
        });
        const command = {
          eventSlug,
          sourceBundleVersionId: previewRequest.sourceBundleVersionId,
          selections,
          previewChecksum: preview.previewChecksum,
          reason: reason.trim(),
          clientOperationId: crypto.randomUUID(),
        };
        return () => migrate(command);
      });
      setMessage(
        `${result.targetCount} ${result.targetCount === 1 ? "person now uses" : "people now use"} the current access set.`,
      );
      setSelections([]);
      setPreviewRequest(null);
      setReason("");
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="permission-command bundle-migration">
      <div>
        <h2>Update existing people</h2>
        <p className="muted">
          Move people from an older copy of this access set to the current one. Any permissions
          given to them directly stay as they are.
        </p>
      </div>

      <form className="bundle-migration-form" onSubmit={requestPreview}>
        <fieldset disabled={busy || migrationPending} style={{ display: "contents" }}>
          <label className="field">
            <span>Older access set</span>
            <select
              value={sourceVersionId ?? ""}
              onChange={(event) => chooseSourceVersion(event.target.value)}
            >
              <option value="">Choose one version</option>
              {sourceVersions.results.map((version) => (
                <option key={version.id} value={version.id}>
                  Previous version · {version.entryCount} permissions
                </option>
              ))}
            </select>
          </label>
          {sourceVersions.status === "CanLoadMore" ? (
            <button
              className="text-button"
              type="button"
              onClick={() => sourceVersions.loadMore(10)}
            >
              Load older versions
            </button>
          ) : null}

          {sourceVersionId ? (
            <div className="bundle-migration-candidates">
              <div className="bundle-migration-candidate-heading">
                <strong>People to update</strong>
                <small>
                  {selections.length} of {maximumTargets} selected
                </small>
              </div>
              {candidates.results.map((candidate) => {
                const selection = selections.find(
                  (item) => item.sourceGrantBatchId === candidate.sourceGrantBatchId,
                );
                const selected = selection !== undefined;
                return (
                  <div className="bundle-migration-candidate" key={candidate.sourceGrantBatchId}>
                    <label>
                      <input
                        checked={selected}
                        disabled={!selected && selections.length >= maximumTargets}
                        type="checkbox"
                        onChange={(event) => toggleCandidate(candidate, event.target.checked)}
                      />
                      <span>
                        <strong>{candidate.displayName}</strong>
                        <small>
                          {candidate.email} · {candidate.activeGrantCount} active permissions
                          {candidate.preservedExceptionCount > 0
                            ? ` · ${candidate.preservedExceptionCount} intentionally off`
                            : ""}
                        </small>
                      </span>
                    </label>
                    {selected && selection && candidate.bindings.length > 0 ? (
                      <div className="bundle-migration-bindings">
                        {candidate.bindings.map((binding) => (
                          <BundleBindingField
                            binding={binding}
                            key={binding.key}
                            targetPersonId={candidate.targetPersonId}
                            value={bindingValue(selection, binding.key)}
                            onChange={(scopeId) =>
                              updateBinding(candidate.sourceGrantBatchId, binding.key, scopeId)
                            }
                          />
                        ))}
                      </div>
                    ) : null}
                  </div>
                );
              })}
              {candidates.status === "LoadingFirstPage" ? (
                <p className="muted">Loading earlier uses…</p>
              ) : null}
              {candidates.status === "Exhausted" && candidates.results.length === 0 ? (
                <p className="empty">Everyone already has the current access.</p>
              ) : null}
              {candidates.status === "CanLoadMore" ? (
                <button
                  className="text-button"
                  type="button"
                  onClick={() => candidates.loadMore(5)}
                >
                  Load more people
                </button>
              ) : null}
            </div>
          ) : null}

          <button
            className="secondary"
            type="submit"
            disabled={selections.length === 0 || !bindingsComplete(selections)}
          >
            Review updates
          </button>
        </fieldset>
      </form>

      {previewRequest && preview === undefined ? <p className="muted">Comparing access…</p> : null}
      {preview || migrationPending ? (
        <div className="bundle-migration-preview">
          {preview ? (
            <>
              <div>
                <strong>Older access → current access</strong>
                <span>
                  {preview.targetCount} {preview.targetCount === 1 ? "person" : "people"}
                </span>
              </div>
              <div className="bundle-diff">
                <span>{preview.createdCount} added</span>
                <span>{preview.reusedCount} already current</span>
                <span>{preview.supersededCount} old permissions replaced</span>
                <span>{preview.preservedCount} exceptions preserved</span>
              </div>
              <div className="bundle-migration-targets">
                {preview.targets.map((target) => (
                  <details key={target.sourceGrantBatchId}>
                    <summary>
                      <span>{target.displayName}</span>
                      <small>{target.changes.length} changes</small>
                    </summary>
                    <ol>
                      {target.changes.map((change, index) => (
                        <li
                          key={`${change.permissionKey}:${change.scopeType}:${change.scopeId ?? "event"}:${index}`}
                        >
                          <span>{permissionName(change.permissionKey)}</span>
                          <small>
                            {changeName(change)} · {scopeName(change.scopeType)}
                          </small>
                        </li>
                      ))}
                    </ol>
                  </details>
                ))}
              </div>
            </>
          ) : (
            <p className="notice">
              Confirm the earlier access update before making another change.
            </p>
          )}
          <label className="field">
            <span>Why these people need the update</span>
            <textarea
              required
              value={reason}
              disabled={busy || migrationPending}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          <button
            className="primary"
            type="button"
            disabled={busy || (!migrationPending && reason.trim().length < 5)}
            onClick={() => void confirmMigration()}
          >
            {busy
              ? "Updating…"
              : migrationPending
                ? "Confirm earlier update"
                : "Update selected people"}
          </button>
          <small className="muted">
            The selected people update together. You may be asked to sign in again.
          </small>
        </div>
      ) : null}
      {message ? (
        <p className="notice" role="status">
          {message}
        </p>
      ) : null}
      {error ? (
        <p className="notice error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function bindingValue(selection: PreviewSelection, key: string) {
  return selection.bindings.find((binding) => binding.key === key)?.scopeId ?? "";
}

function bindingsComplete(selections: PreviewSelection[]) {
  return selections.every((selection) =>
    selection.bindings.every((binding) => binding.scopeId.length > 0),
  );
}

function changeName(change: Change) {
  if (change.action === "add") return "Add";
  if (change.action === "replace") return "Replace old permission";
  if (change.action === "remove") return "Remove old permission";
  return "Keep intentionally off";
}

import { api } from "@code2create/backend/api";
import { eventRoleLabels } from "@code2create/domain";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import * as Papa from "papaparse";
import { useState, type ChangeEvent, type SubmitEvent } from "react";
import { Link } from "react-router-dom";

import { Icon, type IconName } from "../components/Icon";
import { LoadingLabel, SkeletonCard, SkeletonList, SkeletonStats } from "../components/Skeleton";
import { eventSlug } from "../lib/config";
import { readableError } from "../lib/errors";
import { useOperationRunner } from "../lib/operations";
import { useEstimatedServerNow } from "../lib/useEstimatedServerNow";

type Workspace = FunctionReturnType<typeof api.rosters.workspace>;
type Entry = Workspace["entries"][number];
type PreviewRequest = FunctionArgs<typeof api.rosters.previewImport>;
type ImportRow = PreviewRequest["rows"][number];
type RosterRole = ImportRow["role"];
type BundleVersionId = PreviewRequest["bundleVersionIds"][number];
type ImportResult = FunctionReturnType<typeof api.rosters.confirmImport>;

type EntryGroup = "lapsed" | "waiting" | "signed_in" | "ended";

const maximumCsvBytes = 256 * 1024;
const maximumRosterRows = 200;
const maximumBundleSelections = 8;
const rosterRoles = ["supreme", "board", "sc", "jc", "external_judge"] as const;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const roleByWrittenForm = new Map<string, RosterRole>(
  rosterRoles.flatMap((role) => [
    [role, role] as const,
    [normalizedRoleText(eventRoleLabels[role]), role] as const,
  ]),
);
const writtenRoleChoices = rosterRoles.map((role) => eventRoleLabels[role]).join(", ");

const rosterGroups: ReadonlyArray<{ key: EntryGroup; label: string }> = [
  { key: "lapsed", label: "Invitation expired" },
  { key: "waiting", label: "Waiting to sign in" },
  { key: "signed_in", label: "Signed in" },
  { key: "ended", label: "No longer on the team" },
];

export function Roster({ canReadBundles }: { canReadBundles: boolean }) {
  const workspace = useQuery(api.rosters.workspace, { eventSlug });
  const serverNow = useEstimatedServerNow(workspace?.serverNow);
  const rosterPage = usePaginatedQuery(
    api.rosters.list,
    workspace?.canReadAll ? { eventSlug } : "skip",
    { initialNumItems: 50 },
  );
  const confirmImport = useMutation(api.rosters.confirmImport);
  const operations = useOperationRunner<ImportResult>();
  const [showImport, setShowImport] = useState(false);
  const [loadedRoster, setLoadedRoster] = useState<{
    fileName: string;
    rows: ImportRow[];
  } | null>(null);
  const [sourceName, setSourceName] = useState("");
  const [validFromOverride, setValidFrom] = useState<string | null>(null);
  const [validUntilOverride, setValidUntil] = useState<string | null>(null);
  const [bundleVersionIds, setBundleVersionIds] = useState<BundleVersionId[]>([]);
  const [reason, setReason] = useState("");
  const [fileInputKey, setFileInputKey] = useState(0);
  const [previewRequest, setPreviewRequest] = useState<PreviewRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const preview = useQuery(api.rosters.previewImport, previewRequest ?? "skip");

  if (workspace === undefined) {
    return (
      <section className="access-shell roster-workspace">
        <LoadingLabel>Loading the event team</LoadingLabel>
        <SkeletonStats columns={3} />
        <SkeletonList rows={5} />
      </section>
    );
  }

  const entries = workspace.canReadAll ? rosterPage.results : workspace.entries;
  const validFrom = validFromOverride ?? localDateTime(workspace.recommendedValidFrom);
  const validUntil =
    validUntilOverride ??
    (workspace.recommendedValidUntil === undefined
      ? ""
      : localDateTime(workspace.recommendedValidUntil));
  const loadingPeople = workspace.canReadAll && rosterPage.status === "LoadingFirstPage";
  const waiting = entries.filter((entry) => entry.status === "pending").length;
  const signedIn = entries.filter((entry) => entry.status === "claimed").length;
  const lapsed = entries.filter((entry) => entry.status === "expired").length;
  const compatibleBundles = workspace.bundles.filter((bundle) => bundle.rosterCompatible);
  const laterBundles = workspace.bundles.filter((bundle) => !bundle.rosterCompatible);

  const readCsv = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    setPreviewRequest(null);
    setMessage(null);
    setError(null);
    if (!file) {
      setLoadedRoster(null);
      return;
    }
    if (file.size > maximumCsvBytes) {
      setLoadedRoster(null);
      setError("The roster CSV must be 256 KB or smaller.");
      return;
    }
    try {
      const parsed = parseRosterCsv(await file.text());
      setLoadedRoster({ fileName: file.name, rows: parsed });
      setSourceName((current) => current || sourceNameFromFile(file.name));
    } catch (caught) {
      setLoadedRoster(null);
      setError(readableError(caught));
    }
  };

  const requestPreview = (event: SubmitEvent) => {
    event.preventDefault();
    setMessage(null);
    if (!loadedRoster) {
      setError("Choose the CSV holding the people you want to add.");
      return;
    }
    if (sourceName.trim().length < 3) {
      setError("Give this list a name of at least three characters.");
      return;
    }
    const start = new Date(validFrom).getTime();
    const end = new Date(validUntil).getTime();
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start) {
      setError("Choose an access start time, and an end time after it.");
      return;
    }
    if (end <= serverNow) {
      setError("Roster access must end in the future.");
      return;
    }
    if (workspace.recommendedValidUntil !== undefined && end > workspace.recommendedValidUntil) {
      setError("Roster access cannot outlive the event.");
      return;
    }
    if (reason.trim().length < 5) {
      setError("Say why this list is being added, in at least five characters.");
      return;
    }
    setError(null);
    setPreviewRequest({
      eventSlug,
      sourceName,
      sourceFileName: loadedRoster.fileName,
      validFrom: start,
      validUntil: end,
      bundleVersionIds,
      rows: loadedRoster.rows,
      reason,
    });
  };

  const importRoster = async () => {
    if (!previewRequest || !preview) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await operations.run(
        "roster-import",
        (clientOperationId) => () =>
          confirmImport({
            ...previewRequest,
            previewChecksum: preview.previewChecksum,
            clientOperationId,
          }),
      );
      setMessage(
        `Added ${result.createdCount} ${people(result.createdCount)}, replaced ${result.replacedCount} ${invitations(result.replacedCount)}, left ${result.unchangedCount} unchanged, and skipped ${result.alreadyClaimedCount} who had already signed in.`,
      );
      setPreviewRequest(null);
      setLoadedRoster(null);
      setSourceName("");
      setBundleVersionIds([]);
      setReason("");
      setFileInputKey((current) => current + 1);
      setShowImport(false);
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setBusy(false);
    }
  };

  const selectBundle = (versionId: BundleVersionId, selected: boolean) => {
    if (!selected) {
      setBundleVersionIds((current) => current.filter((id) => id !== versionId));
      return;
    }
    if (bundleVersionIds.length >= maximumBundleSelections) {
      setError(`One list can carry at most ${maximumBundleSelections} reusable access sets.`);
      return;
    }
    setError(null);
    setBundleVersionIds((current) => [...current, versionId]);
  };

  return (
    <section className="access-shell roster-workspace">
      <Link className="back-link" to="/access">
        ← People and permissions
      </Link>
      <header className="page-heading">
        <div>
          <h1>Event team</h1>
          <p className="muted">
            The organizers and judges allowed into this event. Anyone not listed cannot sign in.
          </p>
        </div>
        {workspace.canImport ? (
          <button
            aria-expanded={showImport}
            className="secondary"
            type="button"
            onClick={() => setShowImport((current) => !current)}
          >
            {showImport ? "Hide the spreadsheet form" : "Add people from a spreadsheet"}
          </button>
        ) : null}
      </header>

      {loadingPeople ? (
        <>
          <LoadingLabel>Loading the event team</LoadingLabel>
          <SkeletonCard lines={3} />
          <SkeletonStats columns={3} />
        </>
      ) : (
        <>
          <section className="stage-block">
            <p className="eyebrow">Status</p>
            {entries.length === 0 ? (
              <p>Nobody has been added yet, so no organizer or judge can sign in.</p>
            ) : (
              <p>
                {waiting === 0
                  ? `All ${entries.length} ${people(entries.length)} on this list have signed in.`
                  : `${waiting} of ${entries.length} ${people(entries.length)} have not signed in, so they cannot be given work.`}
              </p>
            )}
            {!workspace.canReadAll ? (
              <p className="muted">
                You only see invitations you have access to, so these counts may be incomplete.
              </p>
            ) : rosterPage.status === "CanLoadMore" ? (
              <p className="muted">
                These counts cover the {entries.length} most recently added people.
              </p>
            ) : null}
            {workspace.importBlocker ? <p className="muted">{workspace.importBlocker}</p> : null}
            {!workspace.canImport && !workspace.importBlocker ? (
              <p className="muted">You can read this list but not add people to it.</p>
            ) : null}
          </section>

          {entries.length > 0 ? (
            <dl className="catalog-summary">
              <div>
                <dt>Waiting to sign in</dt>
                <dd>{waiting}</dd>
              </div>
              <div>
                <dt>Signed in</dt>
                <dd>{signedIn}</dd>
              </div>
              <div>
                <dt>Invitation expired</dt>
                <dd>{lapsed}</dd>
              </div>
            </dl>
          ) : null}
        </>
      )}

      {message ? (
        <p className="notice" role="status">
          {message}
        </p>
      ) : null}

      {workspace.canImport && showImport ? (
        <section className="roster-import">
          <div>
            <h2>Add people from a spreadsheet</h2>
            <p className="muted">
              A CSV of up to {maximumRosterRows} rows with the columns <code>email,name,role</code>.
              The role is one of: {writtenRoleChoices}.
            </p>
          </div>

          {previewRequest ? (
            <RosterPreview
              busy={busy}
              preview={preview}
              onCancel={() => {
                setPreviewRequest(null);
                setError(null);
              }}
              onConfirm={() => void importRoster()}
            />
          ) : (
            <form className="roster-import-form" onSubmit={requestPreview}>
              <label className="field roster-file-field">
                <span>Team list</span>
                <input
                  accept=".csv,text/csv"
                  key={fileInputKey}
                  type="file"
                  onChange={(event) => void readCsv(event)}
                />
                {loadedRoster ? (
                  <small>
                    {loadedRoster.rows.length} {people(loadedRoster.rows.length)} read from{" "}
                    {loadedRoster.fileName}
                  </small>
                ) : null}
              </label>
              <label className="field">
                <span>List name</span>
                <input
                  maxLength={100}
                  value={sourceName}
                  onChange={(event) => setSourceName(event.target.value)}
                />
              </label>
              <label className="field">
                <span>Access starts</span>
                <input
                  type="datetime-local"
                  value={validFrom}
                  onChange={(event) => setValidFrom(event.target.value)}
                />
              </label>
              <label className="field">
                <span>Access ends</span>
                <input
                  max={
                    workspace.recommendedValidUntil === undefined
                      ? undefined
                      : localDateTime(workspace.recommendedValidUntil)
                  }
                  type="datetime-local"
                  value={validUntil}
                  onChange={(event) => setValidUntil(event.target.value)}
                />
              </label>
              <fieldset className="roster-bundles">
                <legend>
                  Reusable access <small>Optional</small>
                </legend>
                {compatibleBundles.map((bundle) => (
                  <label className="check-row" key={bundle.versionId}>
                    <input
                      checked={bundleVersionIds.includes(bundle.versionId)}
                      type="checkbox"
                      onChange={(event) => selectBundle(bundle.versionId, event.target.checked)}
                    />
                    <span>
                      {bundle.label} · {bundle.entryCount}{" "}
                      {bundle.entryCount === 1 ? "permission" : "permissions"}
                    </span>
                  </label>
                ))}
                {compatibleBundles.length === 0 ? (
                  <p>
                    No published access set can be handed out at sign-in, so these people arrive
                    with no permissions.
                    {canReadBundles ? (
                      <>
                        {" "}
                        <Link to="/access/bundles">Make a reusable access set</Link>.
                      </>
                    ) : null}
                  </p>
                ) : null}
                {laterBundles.length > 0 ? (
                  <p>
                    {laterBundles.length === 1
                      ? "One other set names a team or panel, so it can only be given after sign-in."
                      : `${laterBundles.length} other sets name a team or panel, so they can only be given after sign-in.`}
                  </p>
                ) : null}
              </fieldset>
              <label className="field roster-reason">
                <span>Why these people are being added</span>
                <textarea
                  maxLength={300}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
              </label>
              <button className="secondary" type="submit">
                Check what this changes
              </button>
            </form>
          )}
          {error ? (
            <p className="notice error" role="alert">
              {error}
            </p>
          ) : null}
        </section>
      ) : null}

      {loadingPeople ? (
        <SkeletonList rows={5} />
      ) : entries.length === 0 ? null : (
        rosterGroups.map((group) => {
          const rows = orderedEntries(entries, group.key);
          if (rows.length === 0) return null;
          return (
            <section key={group.key}>
              <p className="board-section-label">
                {group.label} · {rows.length}
              </p>
              <div className="health-list">
                {rows.map((entry) => (
                  <RosterEntry key={entry.id} entry={entry} />
                ))}
              </div>
            </section>
          );
        })
      )}

      {workspace.canReadAll && rosterPage.status === "CanLoadMore" ? (
        <button className="secondary" type="button" onClick={() => rosterPage.loadMore(50)}>
          Load more people
        </button>
      ) : null}
    </section>
  );
}

function RosterPreview({
  preview,
  busy,
  onConfirm,
  onCancel,
}: {
  preview: FunctionReturnType<typeof api.rosters.previewImport> | undefined;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!preview) {
    return (
      <>
        <LoadingLabel>Checking this list against the access people already have</LoadingLabel>
        <SkeletonCard lines={4} />
      </>
    );
  }
  return (
    <div className="roster-preview">
      <dl className="roster-preview-counts">
        <div>
          <dt>New people</dt>
          <dd>{preview.counts.create}</dd>
        </div>
        <div>
          <dt>Invitation replaced</dt>
          <dd>{preview.counts.replace}</dd>
        </div>
        <div>
          <dt>Unchanged</dt>
          <dd>{preview.counts.unchanged}</dd>
        </div>
        <div>
          <dt>Already signed in</dt>
          <dd>{preview.counts.alreadyClaimed}</dd>
        </div>
      </dl>
      <div className="roster-preview-rows">
        {preview.rows.map((row) => (
          <div key={`${row.rowNumber}:${row.email}`}>
            <span>{row.rowNumber}</span>
            <span>
              <strong>{row.displayName}</strong>
              <small>{row.email}</small>
            </span>
            <span>{eventRoleLabels[row.role]}</span>
            <span>{outcomeName(row.outcome)}</span>
          </div>
        ))}
      </div>
      <p className="muted">
        {preview.bundles.length === 0
          ? "These people arrive with no permissions until someone grants them."
          : `Each person also receives ${preview.bundles.length} reusable access ${preview.bundles.length === 1 ? "set" : "sets"} the first time they sign in.`}
      </p>
      <div className="button-row">
        <button className="primary" type="button" disabled={busy} onClick={onConfirm}>
          {busy ? "Adding…" : "Add these people"}
        </button>
        <button className="text-button" type="button" disabled={busy} onClick={onCancel}>
          Go back and edit
        </button>
      </div>
    </div>
  );
}

function RosterEntry({ entry }: { entry: Entry }) {
  const revoke = useMutation(api.rosters.revoke);
  const operations = useOperationRunner();
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const group = entryGroup(entry.status);

  const confirmRevoke = async () => {
    if (reason.trim().length < 5) {
      setError("Say why this invitation is being removed, in at least five characters.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await operations.run(
        "roster-revoke",
        (clientOperationId) => () =>
          revoke({
            eventSlug,
            rosterEntryId: entry.id,
            expectedVersion: entry.version,
            reason,
            clientOperationId,
          }),
      );
      setConfirming(false);
      setReason("");
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <article className="list-row">
        <span className={`row-glyph ${groupTone(group)}`}>
          <Icon name={groupIcon(group)} />
        </span>
        <div className="row-text">
          <strong>
            {entry.displayName}
            <span className="row-context"> · {eventRoleLabels[entry.role]}</span>
          </strong>
          <small>{statusStatement(entry)}</small>
          <small className="row-context">
            {entry.email} · added from {entry.sourceName}
          </small>
        </div>
        {entry.canRevoke ? (
          <button
            className="row-action"
            type="button"
            onClick={() => setConfirming((current) => !current)}
          >
            {confirming ? "Keep the invitation" : "Remove"}
          </button>
        ) : null}
      </article>
      {confirming ? (
        <div className="roster-revoke">
          <label className="field">
            <span>Why {entry.displayName} is being removed</span>
            <textarea value={reason} onChange={(event) => setReason(event.target.value)} />
          </label>
          <div className="button-row">
            <button
              className="secondary"
              type="button"
              disabled={busy}
              onClick={() => void confirmRevoke()}
            >
              {busy ? "Removing…" : "Remove invitation"}
            </button>
            <button
              className="text-button"
              type="button"
              disabled={busy}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </button>
          </div>
          {error ? (
            <p className="notice error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

function orderedEntries(entries: readonly Entry[], group: EntryGroup) {
  const rows = entries.filter((entry) => entryGroup(entry.status) === group);
  return rows.sort((left, right) =>
    group === "signed_in" || group === "ended"
      ? right.createdAt - left.createdAt
      : left.validUntil - right.validUntil,
  );
}

function entryGroup(status: Entry["status"]): EntryGroup {
  if (status === "expired") return "lapsed";
  if (status === "pending") return "waiting";
  if (status === "claimed") return "signed_in";
  return "ended";
}

function groupTone(group: EntryGroup) {
  if (group === "lapsed") return "attention";
  if (group === "waiting") return "watch";
  return "";
}

function groupIcon(group: EntryGroup): IconName {
  if (group === "lapsed") return "alert";
  if (group === "waiting") return "clock";
  if (group === "signed_in") return "users";
  return "pause";
}

function statusStatement(entry: Entry) {
  if (entry.status === "pending") {
    return `Has not signed in yet. The invitation stays open until ${dateTime(entry.validUntil)}.`;
  }
  if (entry.status === "claimed") {
    return `Signed in. Their access runs until ${dateTime(entry.validUntil)}.`;
  }
  if (entry.status === "expired") {
    return `The invitation ran out on ${dateTime(entry.validUntil)}, so they must be added again.`;
  }
  if (entry.status === "revoked") {
    return "The invitation was removed, so this person can no longer sign in.";
  }
  return "A newer invitation for the same email address replaced this one.";
}

function parseRosterCsv(text: string): ImportRow[] {
  const parsed = Papa.parse<string[]>(text, { skipEmptyLines: false });
  const firstError = parsed.errors[0];
  if (firstError) {
    const row = firstError.row === undefined ? "" : ` on row ${firstError.row + 1}`;
    throw new Error(`CSV parsing failed${row}: ${firstError.message}`);
  }
  const header = parsed.data[0];
  const normalizedHeader = header?.map((cell, index) =>
    (index === 0 ? cell.replace(/^\uFEFF/, "") : cell).trim().toLowerCase(),
  );
  if (
    normalizedHeader?.length !== 3 ||
    normalizedHeader[0] !== "email" ||
    normalizedHeader[1] !== "name" ||
    normalizedHeader[2] !== "role"
  ) {
    throw new Error("The first CSV row must be exactly: email,name,role.");
  }
  const rows: ImportRow[] = [];
  for (let index = 1; index < parsed.data.length; index += 1) {
    const source = parsed.data[index];
    if (!source || source.every((cell) => !cell.trim())) continue;
    const email = source[0]?.trim().toLowerCase();
    const displayName = source[1]?.trim();
    const role = source[2] ? parsedRole(source[2]) : null;
    if (source.length !== 3 || !email || !displayName || !role) {
      throw new Error(
        `CSV row ${index + 1} needs an email, a name, and one of these roles: ${writtenRoleChoices}.`,
      );
    }
    if (!emailPattern.test(email) || email.length > 254) {
      throw new Error(`CSV row ${index + 1} has an invalid email address.`);
    }
    if (displayName.length < 2 || displayName.length > 100) {
      throw new Error(`CSV row ${index + 1} needs a name between 2 and 100 characters.`);
    }
    rows.push({ rowNumber: index + 1, email, displayName, role });
  }
  if (rows.length === 0) throw new Error("The CSV contains no roster rows.");
  if (rows.length > maximumRosterRows) {
    throw new Error(`Import at most ${maximumRosterRows} roster rows at a time.`);
  }
  const duplicate = rows.find((row, index) =>
    rows.some(
      (candidate, candidateIndex) => candidateIndex < index && candidate.email === row.email,
    ),
  );
  if (duplicate) throw new Error(`${duplicate.email} appears more than once in the CSV.`);
  return rows;
}

function normalizedRoleText(value: string) {
  return value.trim().toLowerCase().replace(/[ -]+/g, "_");
}

function parsedRole(value: string): RosterRole | null {
  return roleByWrittenForm.get(normalizedRoleText(value)) ?? null;
}

function sourceNameFromFile(fileName: string) {
  const base = fileName
    .replace(/\.csv$/i, "")
    .trim()
    .slice(0, 100);
  return base.length >= 3 ? base : "Event roster";
}

function localDateTime(timestamp: number) {
  const date = new Date(timestamp);
  return new Date(timestamp - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function dateTime(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp);
}

function people(count: number) {
  return count === 1 ? "person" : "people";
}

function invitations(count: number) {
  return count === 1 ? "invitation" : "invitations";
}

function outcomeName(
  outcome: FunctionReturnType<typeof api.rosters.previewImport>["rows"][number]["outcome"],
) {
  if (outcome === "create") return "New";
  if (outcome === "replace_pending") return "Invitation replaced";
  if (outcome === "replace_expired") return "Invited again";
  if (outcome === "unchanged_pending") return "Unchanged";
  return "Already signed in";
}

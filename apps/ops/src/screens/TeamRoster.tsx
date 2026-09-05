import { LiveNumber } from "../components/LiveNumber";
import { api } from "@code2create/backend/api";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { useState, type ChangeEvent, type SubmitEvent } from "react";
import { Link } from "react-router-dom";

import { Icon, type IconName } from "../components/Icon";
import { LoadingLabel, SkeletonCard, SkeletonList, SkeletonStats } from "../components/Skeleton";
import { eventSlug } from "../lib/config";
import { readableError } from "../lib/errors";
import { useOperationRunner } from "../lib/operations";
import {
  maximumTeamRosterRows,
  parseTeamRosterCsv,
  parseTeamShapedRosterCsv,
} from "../lib/teamRosterCsv";

type Entry = FunctionReturnType<typeof api.teamRosters.list>["page"][number];
type PreviewRequest = FunctionArgs<typeof api.teamRosters.previewImport>;
type ImportRow = PreviewRequest["rows"][number];
type PreviewResult = FunctionReturnType<typeof api.teamRosters.previewImport>;
type ImportResult = FunctionReturnType<typeof api.teamRosters.confirmImport>;

type EntryGroup = "conflict" | "choice" | "waiting" | "joined" | "ended";
type ImportShape = "people" | "teams";

const maximumCsvBytes = 256 * 1024;

const teamRosterGroups: ReadonlyArray<{ key: EntryGroup; label: string }> = [
  { key: "conflict", label: "Account clashes to sort out" },
  { key: "choice", label: "Waiting for a participant to choose" },
  { key: "waiting", label: "Waiting for participants or team leads" },
  { key: "joined", label: "On their team" },
  { key: "ended", label: "Removed or replaced" },
];

export function TeamRoster() {
  const workspace = useQuery(api.teamRosters.workspace, { eventSlug });
  const entryPage = usePaginatedQuery(
    api.teamRosters.list,
    workspace?.canRead ? { eventSlug } : "skip",
    { initialNumItems: 50 },
  );
  const confirmImport = useMutation(api.teamRosters.confirmImport);
  const operations = useOperationRunner<ImportResult>();
  const [showImport, setShowImport] = useState(false);
  const [importShape, setImportShape] = useState<ImportShape>("people");
  const [loadedRoster, setLoadedRoster] = useState<{
    fileName: string;
    rows: ImportRow[];
  } | null>(null);
  const [sourceName, setSourceName] = useState("");
  const [reason, setReason] = useState("");
  const [fileInputKey, setFileInputKey] = useState(0);
  const [previewRequest, setPreviewRequest] = useState<PreviewRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const preview = useQuery(api.teamRosters.previewImport, previewRequest ?? "skip");

  if (workspace === undefined) {
    return (
      <section className="access-shell roster-workspace">
        <LoadingLabel>Loading participant teams</LoadingLabel>
        <SkeletonStats columns={3} />
        <SkeletonList rows={5} />
      </section>
    );
  }

  const entries = entryPage.results;
  const loadingPeople = entryPage.status === "LoadingFirstPage";
  const waiting = workspace.entryCounts.waiting;
  const awaitingChoice = workspace.entryCounts.awaitingChoice;
  const identityConflicts = workspace.entryCounts.identityConflicts;
  const joined = workspace.entryCounts.claimed;
  const total = workspace.entryCounts.total;

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
      setError("The team roster CSV must be 256 KB or smaller.");
      return;
    }
    if (file.type.includes("spreadsheet") || file.name.toLowerCase().endsWith(".xlsx")) {
      setLoadedRoster(null);
      setError("Export the sheet as CSV and upload that file.");
      return;
    }
    try {
      const parsed =
        importShape === "teams"
          ? parseTeamShapedRosterCsv(await file.text())
          : parseTeamRosterCsv(await file.text());
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
      setError("Choose the CSV holding the people you want to place on teams.");
      return;
    }
    if (sourceName.trim().length < 3) {
      setError("Give this list a name of at least three characters.");
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
        "team-roster-import",
        (clientOperationId) => () =>
          confirmImport({
            ...previewRequest,
            previewChecksum: preview.previewChecksum,
            clientOperationId,
          }),
      );
      setMessage(
        preview.counts.identityConflicts > 0
          ? `Recorded ${result.rowCount} ${people(result.rowCount)}. ${preview.counts.identityConflicts} identity ${preview.counts.identityConflicts === 1 ? "conflict needs" : "conflicts need"} duplicate-account cleanup; safe rows will continue joining normally.`
          : preview.counts.choiceRequired > 0
            ? `Recorded ${result.rowCount} ${people(result.rowCount)}. ${preview.counts.choiceRequired} ${people(preview.counts.choiceRequired)} must choose between their current team and the imported team.`
            : `Recorded ${result.rowCount} ${people(result.rowCount)}. They join their team as soon as they sign in, or right away if they already have an account.`,
      );
      setPreviewRequest(null);
      setLoadedRoster(null);
      setSourceName("");
      setReason("");
      setFileInputKey((current) => current + 1);
      setShowImport(false);
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="access-shell roster-workspace">
      <Link className="back-link" to="/access">
        ← People and permissions
      </Link>
      <header className="page-heading">
        <div>
          <h1>Participant teams</h1>
          <p className="muted">
            Place participants on their assigned teams before they sign in. Anyone already on a
            different team chooses which team to keep.
          </p>
        </div>
        {workspace.canImport ? (
          <button
            aria-expanded={showImport}
            className="secondary"
            type="button"
            onClick={() => setShowImport((current) => !current)}
          >
            {showImport ? "Hide the spreadsheet form" : "Import team assignments"}
          </button>
        ) : null}
      </header>

      {loadingPeople ? (
        <>
          <LoadingLabel>Loading participant teams</LoadingLabel>
          <SkeletonCard lines={3} />
          <SkeletonStats columns={3} />
        </>
      ) : (
        <section className="stage-block">
          <p className="eyebrow">Status</p>
          {total === 0 ? (
            <p>No team assignments have been imported yet.</p>
          ) : (
            <>
              <dl className="catalog-summary">
                <div>
                  <dt>On their team</dt>
                  <dd>{joined}</dd>
                </div>
                <div>
                  <dt>Waiting</dt>
                  <dd>{waiting}</dd>
                </div>
                <div>
                  <dt>Needs a choice</dt>
                  <dd>{awaitingChoice}</dd>
                </div>
                <div>
                  <dt>Account clashes</dt>
                  <dd>{identityConflicts}</dd>
                </div>
              </dl>
              <p>
                {waiting === 0 && awaitingChoice === 0 && identityConflicts === 0
                  ? "Every current assignment is resolved."
                  : identityConflicts > 0
                    ? `${identityConflicts} ${people(identityConflicts)} need duplicate VIT accounts resolved; ${waiting} are waiting to join and ${awaitingChoice} need to choose a team.`
                    : awaitingChoice > 0
                      ? `${awaitingChoice} ${people(awaitingChoice)} need to choose a team; ${waiting} are still waiting to join.`
                      : `${waiting} of ${total} ${people(total)} are still waiting to join their team.`}
              </p>
              {!workspace.canImport ? (
                <p className="muted">You can read this list but not import team assignments.</p>
              ) : null}
            </>
          )}
        </section>
      )}

      {message ? (
        <p className="notice" role="status">
          {message}
        </p>
      ) : null}

      {workspace.canImport && showImport ? (
        <section className="roster-import">
          <div>
            <h2>Import team assignments</h2>
            <p className="muted">
              {importShape === "teams" ? (
                <>
                  A CSV of up to {maximumTeamRosterRows} people with the columns{" "}
                  <code>team,lead_name,lead_identity,member_identities</code>. Team can be blank; a
                  new team is created from the lead&apos;s name. Identities are Google emails or VIT
                  registration numbers such as <code>24BCI0150</code>, separated by semicolons.
                </>
              ) : (
                <>
                  A CSV of up to {maximumTeamRosterRows} rows with the columns{" "}
                  <code>identity,name,team,role</code>. Identity is a Google email or a VIT
                  registration number such as <code>24BCI0150</code>. The role is lead or member.
                </>
              )}{" "}
              Export Excel as CSV.
            </p>
          </div>

          {previewRequest ? (
            <TeamRosterPreview
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
              <fieldset className="roster-bundles">
                <legend>How the list is laid out</legend>
                <label className="check-row">
                  <input
                    checked={importShape === "people"}
                    name="roster-import-shape"
                    type="radio"
                    onChange={() => {
                      setImportShape("people");
                      setLoadedRoster(null);
                      setFileInputKey((key) => key + 1);
                      setError(null);
                    }}
                  />
                  Person rows
                </label>
                <label className="check-row">
                  <input
                    checked={importShape === "teams"}
                    name="roster-import-shape"
                    type="radio"
                    onChange={() => {
                      setImportShape("teams");
                      setLoadedRoster(null);
                      setFileInputKey((key) => key + 1);
                      setError(null);
                    }}
                  />
                  Team rows
                </label>
              </fieldset>
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
              <label className="field roster-reason">
                <span>Why this list is being added</span>
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
        teamRosterGroups.map((group) => {
          const rows = orderedEntries(entries, group.key);
          if (rows.length === 0) return null;
          return (
            <section key={group.key}>
              <p className="board-section-label">
                {group.label} · <LiveNumber value={rows.length} />
              </p>
              <div className="health-list">
                {rows.map((entry) => (
                  <TeamRosterEntry key={entry.id} entry={entry} canRevoke={workspace.canRevoke} />
                ))}
              </div>
            </section>
          );
        })
      )}

      {workspace.canRead && entryPage.status === "CanLoadMore" ? (
        <button className="secondary" type="button" onClick={() => entryPage.loadMore(50)}>
          Load more people
        </button>
      ) : null}
    </section>
  );
}

function TeamRosterPreview({
  preview,
  busy,
  onConfirm,
  onCancel,
}: {
  preview: PreviewResult | undefined;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!preview) {
    return (
      <>
        <LoadingLabel>Checking this list against the teams people already have</LoadingLabel>
        <SkeletonCard lines={4} />
      </>
    );
  }
  return (
    <div className="roster-preview">
      <dl className="roster-preview-counts">
        <div>
          <dt>Will be asked to join</dt>
          <dd><LiveNumber value={preview.counts.pending} /></dd>
        </div>
        <div>
          <dt>Account clashes</dt>
          <dd><LiveNumber value={preview.counts.identityConflicts} /></dd>
        </div>
        <div>
          <dt>Already assigned here</dt>
          <dd>{preview.counts.alreadyAssigned}</dd>
        </div>
        <div>
          <dt>Needs a choice</dt>
          <dd><LiveNumber value={preview.counts.choiceRequired} /></dd>
        </div>
        <div>
          <dt>Team not formed yet</dt>
          <dd>{preview.counts.waitingForLead}</dd>
        </div>
        <div>
          <dt>Replaces an earlier row</dt>
          <dd>{preview.counts.superseded}</dd>
        </div>
      </dl>
      <div className="roster-preview-rows">
        {preview.rows.map((row) => (
          <div key={`${row.rowNumber}:${row.identity}`}>
            <span>{row.rowNumber}</span>
            <span>
              <strong>{row.displayName}</strong>
              <small>{row.identity}</small>
            </span>
            <span>
              {row.teamName} · {row.role}
            </span>
            <span>{outcomeName(row.outcome)}</span>
          </div>
        ))}
      </div>
      <p className="muted">
        An import never joins anyone automatically. Each person must accept or leave the listed
        team. People already on a different team choose which one to keep. Clashing accounts are
        noted but not placed, so you can sort out duplicate VIT accounts and import those people
        again.
      </p>
      <div className="button-row">
        <button className="primary" type="button" disabled={busy} onClick={onConfirm}>
          {busy ? "Importing…" : "Place these people"}
        </button>
        <button className="text-button" type="button" disabled={busy} onClick={onCancel}>
          Go back and edit
        </button>
      </div>
    </div>
  );
}

function TeamRosterEntry({ entry, canRevoke }: { entry: Entry; canRevoke: boolean }) {
  const revoke = useMutation(api.teamRosters.revoke);
  const operations = useOperationRunner();
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const group = entryGroup(entry.status);

  const confirmRevoke = async () => {
    if (reason.trim().length < 5) {
      setError("Say why this assignment is being removed, in at least five characters.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await operations.run(
        "team-roster-revoke",
        (clientOperationId) => () =>
          revoke({
            eventSlug,
            teamRosterEntryId: entry.id,
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
            <span className="row-context">
              {" "}
              · {entry.teamName} · {entry.role}
            </span>
          </strong>
          <small>{statusStatement(entry)}</small>
          <small className="row-context">{entry.identity}</small>
        </div>
        {canRevoke && entry.canRevoke ? (
          <button
            className="row-action"
            type="button"
            onClick={() => setConfirming((current) => !current)}
          >
            {confirming ? "Keep the assignment" : "Remove"}
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
              {busy ? "Removing…" : "Remove assignment"}
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
  return rows.sort((left, right) => right.createdAt - left.createdAt);
}

function entryGroup(status: Entry["status"]): EntryGroup {
  if (status === "identity_conflict") return "conflict";
  if (status === "choice_required") return "choice";
  if (status === "pending" || status === "waiting_for_lead") return "waiting";
  if (status === "claimed") return "joined";
  return "ended";
}

function groupTone(group: EntryGroup) {
  if (group === "conflict") return "critical";
  if (group === "choice") return "watch";
  if (group === "waiting") return "watch";
  return "";
}

function groupIcon(group: EntryGroup): IconName {
  if (group === "conflict") return "alert";
  if (group === "waiting") return "clock";
  if (group === "joined") return "users";
  if (group === "choice") return "pause";
  return "alert";
}

function statusStatement(entry: Entry) {
  if (entry.status === "pending") {
    return "Waiting for this participant to accept or leave the assignment.";
  }
  if (entry.status === "waiting_for_lead") {
    return "Accepted. They will join when the listed team lead accepts.";
  }
  if (entry.status === "identity_conflict") {
    return "This registration number belongs to multiple event accounts. Resolve the duplicate accounts, remove this row, then import it again.";
  }
  if (entry.status === "choice_required") {
    return "Already on a different team. The participant must choose which team to keep.";
  }
  if (entry.status === "claimed") return "On their team.";
  if (entry.status === "revoked") return "The assignment was removed.";
  return "A newer assignment for the same person replaced this one.";
}

function sourceNameFromFile(fileName: string) {
  const base = fileName
    .replace(/\.csv$/i, "")
    .trim()
    .slice(0, 100);
  return base.length >= 3 ? base : "Team roster";
}

function people(count: number) {
  return count === 1 ? "person" : "people";
}

function outcomeName(outcome: PreviewResult["rows"][number]["outcome"]) {
  if (outcome === "pending") return "Will be asked to join";
  if (outcome === "identity_conflict") return "Resolve duplicate VIT accounts";
  if (outcome === "already_assigned") return "Already on this team";
  if (outcome === "choice_required") return "Participant must choose";
  return "Will be asked · team not formed";
}

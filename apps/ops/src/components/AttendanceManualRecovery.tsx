import { api } from "@code2create/backend/api";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { useAction, useMutation, useQuery } from "convex/react";
import { useEffect, useState, type SubmitEvent } from "react";

import { eventSlug } from "../lib/config";
import { readableError } from "../lib/errors";
import { useMutationAttempt } from "../lib/operations";
import { compressPaperImage } from "../lib/paperImage";

type AttendanceOverview = FunctionReturnType<typeof api.attendanceOperations.overview>;
type AttendanceSession = AttendanceOverview["sessions"][number];
type IncidentData = FunctionReturnType<typeof api.incidents.forService>;
type Incident = IncidentData["incidents"][number];
type ManualData = FunctionReturnType<typeof api.attendanceManualSheets.forSession>;
type ManualSheet = ManualData["sheets"][number];
type ManualStation = ManualData["stations"][number];
type IncidentSeverity = FunctionArgs<typeof api.incidents.create>["severity"];
type ManualTransition = FunctionArgs<typeof api.attendanceManualSheets.createDraft>["transition"];
type VerificationKind = "import" | "reject";

const manualSheetStatusLabels: Record<ManualSheet["status"], string> = {
  draft: "Draft",
  submitted: "Awaiting verifier",
  imported: "Imported",
  needs_review: "Imported · needs review",
  rejected: "Rejected",
  cancelled: "Cancelled",
};

type DraftRow = {
  key: string;
  lineNumber: string;
  participantReference: string;
  capturedAt: string;
  operatorInitials: string;
  correctionReason: string;
};

export default function AttendanceManualRecovery({
  session,
  serverNow,
}: {
  session: AttendanceSession;
  serverNow: number;
}) {
  const incidents = useQuery(api.incidents.forService, {
    eventSlug,
    affectedService: "attendance_backend",
  });
  const manual = useQuery(api.attendanceManualSheets.forSession, {
    eventSlug,
    sessionId: session.id,
  });

  if (incidents === undefined || manual === undefined) {
    return <p className="muted manual-recovery-loading">Loading paper recovery…</p>;
  }

  return (
    <section className="manual-recovery">
      <div className="section-heading">
        <div>
          <h2>Paper recovery</h2>
          <p className="muted">
            Only for an approved incident. One person types in the numbered sheet and another checks
            it against the photo.
          </p>
        </div>
      </div>

      <IncidentArea data={incidents} />

      {manual.canEnter && session.status === "open" ? (
        <DraftSheetForm
          session={session}
          incidents={incidents.incidents}
          stations={manual.stations}
          serverNow={serverNow}
        />
      ) : null}

      <div className="manual-sheet-list">
        {manual.sheets.map((sheet) => (
          <ManualSheetCard key={sheet.id} session={session} sheet={sheet} />
        ))}
        {manual.sheets.length === 0 ? (
          <p className="empty">No paper sheets recorded for this session.</p>
        ) : null}
      </div>
    </section>
  );
}

function IncidentArea({ data }: { data: IncidentData }) {
  const createIncident = useMutation(api.incidents.create);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [severity, setSeverity] = useState<IncidentSeverity>("service_disruption");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const createAttempt = useMutationAttempt<FunctionReturnType<typeof api.incidents.create>>();
  const createPending = createAttempt.hasPending("attendance-incident-create");

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await createAttempt.run("attendance-incident-create", () => {
        const args = {
          eventSlug,
          title,
          summary,
          severity,
          affectedService: "attendance_backend" as const,
          clientOperationId: crypto.randomUUID(),
        };
        return () => createIncident(args);
      });
      setTitle("");
      setSummary("");
      setSeverity("service_disruption");
      setOpen(false);
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="manual-incidents">
      <div className="manual-subheading">
        <div>
          <strong>Attendance incidents</strong>
          <span>Paper mode needs two different people to approve it.</span>
        </div>
        {data.canCreate && !open ? (
          <button className="secondary" type="button" onClick={() => setOpen(true)}>
            Open incident
          </button>
        ) : null}
      </div>
      {open ? (
        <form className="manual-compact-form" onSubmit={submit}>
          <label className="field">
            <span>Title</span>
            <input
              required
              value={title}
              disabled={createPending}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Check-in system unavailable"
            />
          </label>
          <label className="field">
            <span>Severity</span>
            <select
              value={severity}
              disabled={createPending}
              onChange={(event) => setSeverity(parseSeverity(event.target.value))}
            >
              <option value="service_disruption">Service disruption</option>
              <option value="major">Major</option>
              <option value="critical">Critical</option>
            </select>
          </label>
          <label className="field manual-wide">
            <span>What failed</span>
            <textarea
              required
              value={summary}
              disabled={createPending}
              onChange={(event) => setSummary(event.target.value)}
              placeholder="What was checked, and why normal scanning cannot continue?"
            />
          </label>
          <div className="button-row manual-wide">
            <button className="primary" type="submit" disabled={busy}>
              {busy ? "Opening…" : createPending ? "Confirm incident" : "Open incident"}
            </button>
            <button
              className="secondary"
              type="button"
              disabled={busy || createPending}
              onClick={() => {
                setOpen(false);
                setError(null);
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : null}
      <div className="grid gap-4">
        {data.incidents.map((incident) => (
          <IncidentRow key={incident.id} incident={incident} />
        ))}
      </div>
      {error ? (
        <p className="notice error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function IncidentRow({ incident }: { incident: Incident }) {
  const approve = useMutation(api.incidents.approveManualMode);
  const resolve = useMutation(api.incidents.resolve);
  const [approvalReason, setApprovalReason] = useState("");
  const [resolutionReason, setResolutionReason] = useState("");
  const [busy, setBusy] = useState<"approve" | "resolve" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const approveAttempt =
    useMutationAttempt<FunctionReturnType<typeof api.incidents.approveManualMode>>();
  const resolveAttempt = useMutationAttempt<FunctionReturnType<typeof api.incidents.resolve>>();
  const approvalPending = approveAttempt.hasPending("approve-manual-mode");
  const resolutionPending = resolveAttempt.hasPending("resolve-incident");
  const operationPending = approvalPending || resolutionPending;

  const submitApproval = async (event: SubmitEvent) => {
    event.preventDefault();
    setBusy("approve");
    setError(null);
    try {
      await approveAttempt.run("approve-manual-mode", () => {
        const args = {
          eventSlug,
          incidentId: incident.id,
          expectedIncidentVersion: incident.version,
          reason: approvalReason,
          clientOperationId: crypto.randomUUID(),
        };
        return () => approve(args);
      });
      setApprovalReason("");
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setBusy(null);
    }
  };

  const submitResolution = async (event: SubmitEvent) => {
    event.preventDefault();
    setBusy("resolve");
    setError(null);
    try {
      await resolveAttempt.run("resolve-incident", () => {
        const args = {
          eventSlug,
          incidentId: incident.id,
          expectedIncidentVersion: incident.version,
          reason: resolutionReason,
          clientOperationId: crypto.randomUUID(),
        };
        return () => resolve(args);
      });
      setResolutionReason("");
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setBusy(null);
    }
  };

  return (
    <article className="manual-incident">
      <div className="manual-incident-summary">
        <div>
          <strong>{incident.title}</strong>
          <span>{incident.summary}</span>
        </div>
        <small>
          {incidentState(incident)} · {new Date(incident.openedAt).toLocaleString()}
        </small>
      </div>
      {incident.approvals.length > 0 ? (
        <p className="manual-approvals">
          {incident.approvals.map((approval) => approval.displayName).join(" · ")}
        </p>
      ) : null}
      {incident.canApproveManualMode ? (
        <form className="manual-inline-form" onSubmit={submitApproval}>
          <input
            required
            value={approvalReason}
            disabled={operationPending}
            onChange={(event) => setApprovalReason(event.target.value)}
            placeholder="Why paper mode is necessary"
          />
          <button className="secondary" type="submit" disabled={busy !== null || resolutionPending}>
            {busy === "approve"
              ? "Approving…"
              : approvalPending
                ? "Confirm earlier approval"
                : "Approve manual mode"}
          </button>
        </form>
      ) : null}
      {incident.canResolve && incident.manualModeState === "approved" ? (
        <form className="manual-inline-form" onSubmit={submitResolution}>
          <input
            required
            value={resolutionReason}
            disabled={operationPending}
            onChange={(event) => setResolutionReason(event.target.value)}
            placeholder="How service recovered"
          />
          <button className="text-button" type="submit" disabled={busy !== null || approvalPending}>
            {busy === "resolve"
              ? "Resolving…"
              : resolutionPending
                ? "Confirm earlier resolution"
                : "Resolve incident"}
          </button>
        </form>
      ) : null}
      {error ? (
        <p className="notice error" role="alert">
          {error}
        </p>
      ) : null}
    </article>
  );
}

function DraftSheetForm({
  session,
  incidents,
  stations,
  serverNow,
}: {
  session: AttendanceSession;
  incidents: Incident[];
  stations: ManualStation[];
  serverNow: number;
}) {
  const createDraft = useMutation(api.attendanceManualSheets.createDraft);
  const approvedIncidents = incidents.filter(
    (incident) => incident.state !== "resolved" && incident.manualModeState === "approved",
  );
  const [open, setOpen] = useState(false);
  const [incidentId, setIncidentId] = useState("");
  const [stationId, setStationId] = useState("");
  const [serial, setSerial] = useState("");
  const [transition, setTransition] = useState<ManualTransition>("session_confirm");
  const [rows, setRows] = useState<DraftRow[]>(() => [newDraftRow(1, serverNow)]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const createAttempt =
    useMutationAttempt<FunctionReturnType<typeof api.attendanceManualSheets.createDraft>>();
  const createPending = createAttempt.hasPending("manual-sheet-create");

  const invalidate = () => {
    setError(null);
    setNotice(null);
  };

  const updateRow = (key: string, field: keyof Omit<DraftRow, "key">, value: string) => {
    invalidate();
    setRows((current) =>
      current.map((row) => (row.key === key ? { ...row, [field]: value } : row)),
    );
  };

  const chooseStation = (value: string) => {
    invalidate();
    setStationId(value);
  };

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    const incident = approvedIncidents.find((candidate) => candidate.id === incidentId);
    const station = stations.find((candidate) => candidate.id === stationId);
    if (!incident || !station) {
      setError("Choose an approved incident and the station printed on the sheet.");
      return;
    }
    const entries: FunctionArgs<typeof api.attendanceManualSheets.createDraft>["entries"] = [];
    for (const row of rows) {
      const lineNumber = Number(row.lineNumber);
      const capturedAt = Date.parse(row.capturedAt);
      if (!Number.isSafeInteger(lineNumber) || !Number.isSafeInteger(capturedAt)) {
        setError("Every row needs a valid line number and local time.");
        return;
      }
      entries.push({
        lineNumber,
        participantReference: row.participantReference,
        capturedAt,
        operatorInitials: row.operatorInitials,
        ...(row.correctionReason.trim() === "" ? {} : { correctionReason: row.correctionReason }),
      });
    }
    setBusy(true);
    setError(null);
    try {
      await createAttempt.run("manual-sheet-create", () => {
        const args = {
          eventSlug,
          incidentId: incident.id,
          sessionId: session.id,
          stationId: station.id,
          expectedIncidentVersion: incident.version,
          expectedSessionVersion: session.version,
          serial,
          transition,
          entries,
          clientOperationId: crypto.randomUUID(),
        };
        return () => createDraft(args);
      });
      setSerial("");
      setRows([newDraftRow(1, serverNow)]);
      setNotice("Draft saved. Attach the source photo below; another person must verify it.");
      setOpen(false);
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <div className="manual-new-sheet">
        <button
          className="secondary"
          type="button"
          disabled={approvedIncidents.length === 0 || stations.length === 0}
          onClick={() => setOpen(true)}
        >
          Enter paper sheet
        </button>
        {approvedIncidents.length === 0 ? <span>Waiting for two incident approvals.</span> : null}
        {notice ? <span>{notice}</span> : null}
      </div>
    );
  }

  return (
    <form className="manual-sheet-form" onSubmit={submit}>
      <div className="manual-sheet-meta">
        <label className="field">
          <span>Incident</span>
          <select
            disabled={createPending}
            required
            value={incidentId}
            onChange={(event) => {
              invalidate();
              setIncidentId(event.target.value);
            }}
          >
            <option value="">Choose</option>
            {approvedIncidents.map((incident) => (
              <option key={incident.id} value={incident.id}>
                {incident.title}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Sheet serial</span>
          <input
            disabled={createPending}
            required
            value={serial}
            onChange={(event) => {
              invalidate();
              setSerial(event.target.value);
            }}
            placeholder="A-001"
          />
        </label>
        <label className="field">
          <span>Station</span>
          <select
            disabled={createPending}
            required
            value={stationId}
            onChange={(event) => chooseStation(event.target.value)}
          >
            <option value="">Choose</option>
            {stations.map((station) => (
              <option key={station.id} value={station.id}>
                {station.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Direction</span>
          <select
            disabled={createPending}
            value={transition}
            onChange={(event) => {
              invalidate();
              setTransition(parseTransition(event.target.value));
            }}
          >
            <option value="session_confirm">Session confirmation</option>
            <option value="zone_entry">Return / entry</option>
            <option value="zone_exit">Temporary exit</option>
          </select>
        </label>
      </div>
      <div className="manual-entry-table">
        {rows.map((row) => (
          <div className="manual-entry-row" key={row.key}>
            <label className="field">
              <span>Line</span>
              <input
                disabled={createPending}
                inputMode="numeric"
                required
                value={row.lineNumber}
                onChange={(event) => updateRow(row.key, "lineNumber", event.target.value)}
              />
            </label>
            <label className="field">
              <span>Participant / VIT reg / badge</span>
              <input
                disabled={createPending}
                required
                value={row.participantReference}
                onChange={(event) => updateRow(row.key, "participantReference", event.target.value)}
              />
            </label>
            <label className="field">
              <span>Local time</span>
              <input
                disabled={createPending}
                type="datetime-local"
                step="60"
                required
                value={row.capturedAt}
                onChange={(event) => updateRow(row.key, "capturedAt", event.target.value)}
              />
            </label>
            <label className="field">
              <span>Initials</span>
              <input
                disabled={createPending}
                required
                value={row.operatorInitials}
                onChange={(event) => updateRow(row.key, "operatorInitials", event.target.value)}
              />
            </label>
            <label className="field">
              <span>Correction reason, if any</span>
              <input
                disabled={createPending}
                value={row.correctionReason}
                onChange={(event) => updateRow(row.key, "correctionReason", event.target.value)}
              />
            </label>
            {rows.length > 1 ? (
              <button
                className="text-button manual-remove-row"
                disabled={createPending}
                type="button"
                onClick={() => {
                  invalidate();
                  setRows((current) => current.filter((candidate) => candidate.key !== row.key));
                }}
              >
                Remove
              </button>
            ) : null}
          </div>
        ))}
      </div>
      <div className="button-row">
        <button
          className="secondary"
          type="button"
          disabled={createPending || rows.length >= 25}
          onClick={() => {
            invalidate();
            setRows((current) => [...current, newDraftRow(current.length + 1, serverNow)]);
          }}
        >
          Add line
        </button>
        <button className="primary" type="submit" disabled={busy}>
          {busy ? "Saving…" : createPending ? "Confirm earlier draft" : "Save draft"}
        </button>
        <button
          className="secondary"
          type="button"
          disabled={busy || createPending}
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
        >
          Cancel
        </button>
      </div>
      <p className="muted">
        A single sheet has one station and direction. Each row is matched to this session before the
        draft is accepted.
      </p>
      {error ? (
        <p className="notice error" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}

function ManualSheetCard({ session, sheet }: { session: AttendanceSession; sheet: ManualSheet }) {
  return (
    <article className="manual-sheet-card">
      <div className="manual-sheet-title">
        <div>
          <strong>
            {sheet.serial}
            {sheet.revision > 1 ? ` · revision ${sheet.revision}` : ""}
          </strong>
          <span>
            {sheet.stationName} · {transitionName(sheet.transition)} · {sheet.entries.length} lines
          </span>
        </div>
        <small>{sheetStatus(sheet.status)}</small>
      </div>
      <p className="manual-sheet-owner">
        Entered by {sheet.enteredByName} · {new Date(sheet.enteredAt).toLocaleString()} ·{" "}
        {sheet.incidentTitle}
      </p>
      <details>
        <summary>Entered rows</summary>
        <ol className="manual-sheet-entries">
          {sheet.entries.map((entry) => (
            <li key={entry.lineNumber}>
              <span>
                {entry.lineNumber}. {entry.participantName}
              </span>
              <small>
                {entry.participantReference} · {new Date(entry.capturedAt).toLocaleString()} ·{" "}
                {entry.operatorInitials}
              </small>
            </li>
          ))}
        </ol>
      </details>
      {sheet.canUploadSource ? <SourceUpload sheet={sheet} /> : null}
      {sheet.canReadSource ? <SourcePreview sheet={sheet} /> : null}
      {sheet.canVerify ? <SheetVerification session={session} sheet={sheet} /> : null}
      {sheet.status === "draft" && sheet.canUploadSource ? (
        <DraftCancellation sheet={sheet} />
      ) : null}
      {sheet.importSummary ? (
        <p className="manual-import-summary">
          {sheet.importSummary.accepted} accepted · {sheet.importSummary.duplicate} duplicate ·{" "}
          {sheet.importSummary.needsReview} review · {sheet.importSummary.rejected} rejected
        </p>
      ) : null}
      {sheet.rejectionReason ? (
        <p className="notice error">Rejected: {sheet.rejectionReason}</p>
      ) : null}
      {sheet.cancellationReason ? (
        <p className="muted">Cancelled: {sheet.cancellationReason}</p>
      ) : null}
    </article>
  );
}

function SourceUpload({ sheet }: { sheet: ManualSheet }) {
  const upload = useAction(api.attendanceManualSheetActions.uploadSource);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const uploadAttempt =
    useMutationAttempt<FunctionReturnType<typeof api.attendanceManualSheetActions.uploadSource>>();
  const uploadPending = uploadAttempt.hasPending("manual-sheet-source-upload");

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const compressed = await compressPaperImage(file, "attendance-sheet");
      await uploadAttempt.run("manual-sheet-source-upload", () => {
        const args = {
          eventSlug,
          sheetId: sheet.id,
          expectedSheetVersion: sheet.version,
          bytes: compressed.bytes,
          fileName: compressed.fileName,
          clientOperationId: crypto.randomUUID(),
        };
        return () => upload(args);
      });
      setFile(null);
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="manual-source-upload" onSubmit={submit}>
      <label className="field">
        <span>Photograph of the complete sheet</span>
        <input
          type="file"
          accept="image/*"
          disabled={uploadPending}
          required
          onChange={(event) => {
            setError(null);
            setFile(event.target.files?.item(0) ?? null);
          }}
        />
      </label>
      <button className="primary" type="submit" disabled={busy || !file}>
        {busy
          ? "Compressing and submitting…"
          : uploadPending
            ? "Confirm earlier upload"
            : "Submit for verification"}
      </button>
      <p className="muted">
        The browser makes one readable JPEG under 900 KB. The paper sheet stays the official record.
      </p>
      {error ? (
        <p className="notice error" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}

function SourcePreview({ sheet }: { sheet: ManualSheet }) {
  const readSource = useAction(api.attendanceManualSheetActions.readSource);
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(
    () => () => {
      if (url) URL.revokeObjectURL(url);
    },
    [url],
  );

  const load = async () => {
    setBusy(true);
    setError(null);
    try {
      const source = await readSource({ eventSlug, sheetId: sheet.id });
      if (url) URL.revokeObjectURL(url);
      setUrl(URL.createObjectURL(new Blob([source.bytes], { type: source.contentType })));
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="manual-source-preview">
      {!url ? (
        <button className="text-button" type="button" disabled={busy} onClick={() => void load()}>
          {busy ? "Loading source…" : "View protected source"}
        </button>
      ) : (
        <>
          <img src={url} alt={`Numbered attendance sheet ${sheet.serial}`} />
          <button
            className="text-button"
            type="button"
            onClick={() => {
              URL.revokeObjectURL(url);
              setUrl(null);
            }}
          >
            Hide source
          </button>
        </>
      )}
      {error ? (
        <p className="notice error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function SheetVerification({ session, sheet }: { session: AttendanceSession; sheet: ManualSheet }) {
  const verify = useMutation(api.attendanceManualSheets.verify);
  const [kind, setKind] = useState<VerificationKind>("import");
  const [reason, setReason] = useState("");
  const [originalFiled, setOriginalFiled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const verifyAttempt =
    useMutationAttempt<FunctionReturnType<typeof api.attendanceManualSheets.verify>>();
  const verifyPending = verifyAttempt.hasPending("manual-sheet-verify");

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await verifyAttempt.run("manual-sheet-verify", () => {
        const args =
          kind === "reject"
            ? ({
                eventSlug,
                sheetId: sheet.id,
                expectedSheetVersion: sheet.version,
                expectedSessionVersion: session.version,
                decision: { kind: "reject" },
                reason,
                clientOperationId: crypto.randomUUID(),
              } as const)
            : ({
                eventSlug,
                sheetId: sheet.id,
                expectedSheetVersion: sheet.version,
                expectedSessionVersion: session.version,
                decision: { kind: "import", originalFiled },
                reason,
                clientOperationId: crypto.randomUUID(),
              } as const);
        return () => verify(args);
      });
      setReason("");
      setOriginalFiled(false);
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="manual-verification" onSubmit={submit}>
      <label className="field">
        <span>Decision</span>
        <select
          disabled={verifyPending}
          value={kind}
          onChange={(event) => {
            setError(null);
            setKind(parseVerificationKind(event.target.value));
          }}
        >
          <option value="import">Verify and import</option>
          <option value="reject">Reject this entry</option>
        </select>
      </label>
      <label className="field">
        <span>Reason</span>
        <input
          disabled={verifyPending}
          required
          value={reason}
          onChange={(event) => {
            setError(null);
            setReason(event.target.value);
          }}
          placeholder="What you checked against the paper"
        />
      </label>
      {kind === "import" ? (
        <label className="manual-check">
          <input
            type="checkbox"
            checked={originalFiled}
            disabled={verifyPending}
            onChange={(event) => {
              setError(null);
              setOriginalFiled(event.target.checked);
            }}
          />
          <span>The numbered original is in the event’s records.</span>
        </label>
      ) : null}
      <button
        className={kind === "reject" ? "secondary" : "primary"}
        type="submit"
        disabled={busy || (kind === "import" && !originalFiled)}
      >
        {busy
          ? "Applying…"
          : verifyPending
            ? "Confirm earlier decision"
            : kind === "reject"
              ? "Reject sheet"
              : "Import paper rows"}
      </button>
      <p className="muted">
        Rows older than a newer online scan are kept for review and don’t overwrite it.
      </p>
      {error ? (
        <p className="notice error" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}

function DraftCancellation({ sheet }: { sheet: ManualSheet }) {
  const cancel = useMutation(api.attendanceManualSheets.cancelDraft);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelAttempt =
    useMutationAttempt<FunctionReturnType<typeof api.attendanceManualSheets.cancelDraft>>();
  const cancelPending = cancelAttempt.hasPending("manual-sheet-cancel");

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await cancelAttempt.run("manual-sheet-cancel", () => {
        const args = {
          eventSlug,
          sheetId: sheet.id,
          expectedSheetVersion: sheet.version,
          reason,
          clientOperationId: crypto.randomUUID(),
        };
        return () => cancel(args);
      });
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setBusy(false);
    }
  };

  if (!open)
    return (
      <button className="text-button" type="button" onClick={() => setOpen(true)}>
        Cancel draft
      </button>
    );
  return (
    <form className="manual-inline-form" onSubmit={submit}>
      <input
        disabled={cancelPending}
        required
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        placeholder="Why this draft should be replaced"
      />
      <button className="secondary" type="submit" disabled={busy}>
        {busy ? "Cancelling…" : cancelPending ? "Confirm earlier cancellation" : "Confirm cancel"}
      </button>
      {error ? (
        <p className="notice error" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}

function newDraftRow(lineNumber: number, serverNow: number): DraftRow {
  return {
    key: crypto.randomUUID(),
    lineNumber: String(lineNumber),
    participantReference: "",
    capturedAt: localDateTime(serverNow),
    operatorInitials: "",
    correctionReason: "",
  };
}

function localDateTime(timestamp: number) {
  const date = new Date(timestamp);
  const local = new Date(timestamp - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function parseSeverity(value: string): IncidentSeverity {
  if (value === "major" || value === "critical") return value;
  return "service_disruption";
}

function isManualTransition(value: string): value is ManualTransition {
  return value === "session_confirm" || value === "zone_entry" || value === "zone_exit";
}

function parseTransition(value: string): ManualTransition {
  return isManualTransition(value) ? value : "session_confirm";
}

function parseVerificationKind(value: string): VerificationKind {
  return value === "reject" ? "reject" : "import";
}

function transitionName(value: ManualTransition) {
  if (value === "zone_entry") return "return / entry";
  if (value === "zone_exit") return "temporary exit";
  return "session confirmation";
}

function sheetStatus(value: ManualSheet["status"]) {
  return manualSheetStatusLabels[value];
}

function incidentState(incident: Incident) {
  if (incident.state === "resolved") return "Resolved";
  if (incident.manualModeState === "approved") return "Manual mode approved";
  if (incident.manualModeState === "pending")
    return `Approval ${incident.manualModeApprovalCount} of 2`;
  return "Manual mode not approved";
}

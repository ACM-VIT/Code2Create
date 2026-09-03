import { api } from "@code2create/backend/api";
import {
  mergeSynesthesiaVoteCounts,
  synesthesiaCatalogTrackStatusLabels,
  synesthesiaWindowKindLabels,
  synesthesiaWindowStatusLabels,
} from "@code2create/domain";
import type { FunctionReturnType } from "convex/server";
import { useAction, useMutation, useQuery } from "convex/react";
import { useEffect, useState } from "react";

import { LoadingLabel, SkeletonCard, SkeletonList } from "../components/Skeleton";
import { SynesthesiaHostPlayer } from "../components/SynesthesiaHostPlayer";
import { SynesthesiaRequestCard } from "../components/SynesthesiaRequestCard";
import { eventSlug } from "../lib/config";
import { readableError } from "../lib/errors";
import { useEstimatedServerNow } from "../lib/useEstimatedServerNow";
import { useOperationRunner } from "../lib/operations";

type Overview = FunctionReturnType<typeof api.synesthesiaConfiguration.overview>;
type SynesthesiaWindow = Overview["windows"][number];
type WindowKind = SynesthesiaWindow["kind"];
type WindowStatus = SynesthesiaWindow["status"];
type CatalogResult = FunctionReturnType<typeof api.synesthesiaConfiguration.catalog>;
type CatalogTrack = CatalogResult["tracks"][number];
type QueueResult = FunctionReturnType<typeof api.synesthesiaOperations.queue>;
type QueueRequest = QueueResult["requests"][number] & { voteCount: number };
type YouTubeVideo = FunctionReturnType<typeof api.synesthesiaYouTube.search>[number];

const windowKinds: WindowKind[] = [
  "arrival",
  "working_session",
  "late_night",
  "morning_reset",
  "judging",
  "closing",
  "custom",
];

const windowOrder: Record<WindowStatus, number> = {
  published: 0,
  draft: 1,
  closed: 2,
};

type CatalogValues = {
  provider: string;
  providerTrackId: string;
  title: string;
  artist: string;
  album: string;
  durationSeconds: string;
  isExplicit: boolean;
  energyTag: string;
  status: CatalogTrack["status"];
  reason: string;
};

type CatalogEditor =
  | { mode: "create"; values: CatalogValues }
  | {
      mode: "edit";
      trackId: CatalogTrack["id"];
      expectedVersion: number;
      values: CatalogValues;
    };

type WindowValues = {
  name: string;
  kind: WindowKind;
  customKindLabel: string;
  startsAt: string;
  endsAt: string;
  requestsOpen: boolean;
  votingOpen: boolean;
  catalogSourceLabel: string;
  autoApproveRequests: boolean;
  maxRequestsPerParticipant: string;
  maxVotesPerParticipant: string;
  maxRequestsTotal: string;
  maxTrackDurationSeconds: string;
  allowExplicit: boolean;
  allowedEnergyTags: string;
  reason: string;
};

type WindowEditor =
  | { mode: "create"; values: WindowValues }
  | {
      mode: "edit";
      windowId: SynesthesiaWindow["id"];
      expectedVersion: number;
      values: WindowValues;
    };

type WindowAction = {
  windowId: SynesthesiaWindow["id"];
  expectedVersion: number;
  kind: "publish" | "close" | "pause" | "resume";
};

function windowKindFromValue(value: string) {
  return windowKinds.find((kind) => kind === value);
}

function localDateTime(timestamp: number) {
  const date = new Date(timestamp);
  const localTimestamp = timestamp - date.getTimezoneOffset() * 60_000;
  return new Date(localTimestamp).toISOString().slice(0, 16);
}

function timestampFromLocal(value: string) {
  const timestamp = new Date(value).getTime();
  return Number.isSafeInteger(timestamp) ? timestamp : null;
}

function integerFromValue(value: string) {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function initialWindowValues(serverNow: number): WindowValues {
  const startsAt = Math.ceil(serverNow / 300_000) * 300_000;
  return {
    name: "",
    kind: "working_session",
    customKindLabel: "",
    startsAt: localDateTime(startsAt),
    endsAt: localDateTime(startsAt + 90 * 60_000),
    requestsOpen: true,
    votingOpen: true,
    catalogSourceLabel: "",
    autoApproveRequests: false,
    maxRequestsPerParticipant: "3",
    maxVotesPerParticipant: "8",
    maxRequestsTotal: "120",
    maxTrackDurationSeconds: "480",
    allowExplicit: false,
    allowedEnergyTags: "calm, focused, upbeat",
    reason: "",
  };
}

function valuesForWindow(window: SynesthesiaWindow): WindowValues {
  return {
    name: window.name,
    kind: window.kind,
    customKindLabel: window.customKindLabel ?? "",
    startsAt: localDateTime(window.startsAt),
    endsAt: localDateTime(window.endsAt),
    requestsOpen: window.requestsOpen,
    votingOpen: window.votingOpen,
    catalogSourceLabel: window.catalogSourceLabel,
    autoApproveRequests: window.autoApproveRequests,
    maxRequestsPerParticipant: String(window.maxRequestsPerParticipant),
    maxVotesPerParticipant: String(window.maxVotesPerParticipant),
    maxRequestsTotal: String(window.maxRequestsTotal),
    maxTrackDurationSeconds: String(window.maxTrackDurationSeconds),
    allowExplicit: window.allowExplicit,
    allowedEnergyTags: window.allowedEnergyTags.join(", "),
    reason: "",
  };
}

function emptyCatalogValues(): CatalogValues {
  return {
    provider: "",
    providerTrackId: "",
    title: "",
    artist: "",
    album: "",
    durationSeconds: "",
    isExplicit: false,
    energyTag: "focused",
    status: "active",
    reason: "",
  };
}

function countLabel(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function catalogOrder(track: CatalogTrack) {
  return track.status === "active" ? 0 : 1;
}

function requestableCount(catalog: CatalogResult) {
  return catalog.tracks.filter((track) => track.status === "active").length;
}

function windowConsequence(window: SynesthesiaWindow) {
  if (window.status === "closed") {
    return "Closed. No new request can arrive and nothing more will play from it.";
  }
  if (window.status === "draft") {
    return "Participants cannot see this window yet. Publish it before it starts, or no request will arrive.";
  }
  if (window.playbackPaused) {
    return window.playbackPauseReason
      ? `Playback is paused: ${window.playbackPauseReason}. Requests keep arriving but nothing new will start.`
      : "Playback is paused. Requests keep arriving but nothing new will start.";
  }
  if (!window.requestsOpen) {
    return "Open, but requests are closed, so no new song can be added to the queue.";
  }
  return "Open. Participants can request songs and the queue below is live.";
}

function playbackBlocker(queue: QueueResult) {
  if (queue.window.status !== "published") {
    return "This window is not open, so nothing can be started from it.";
  }
  if (queue.window.playbackPaused) {
    return queue.window.playbackPauseReason
      ? `Playback is paused: ${queue.window.playbackPauseReason}. Resume it above before starting a song.`
      : "Playback is paused. Resume it above before starting a song.";
  }
  const playing = queue.requests.find((request) => request.state === "playing");
  if (playing) {
    return `“${playing.title}” is playing. Mark it played or skipped before starting another song.`;
  }
  return null;
}

export function Synesthesia() {
  const overview = useQuery(api.synesthesiaConfiguration.overview, { eventSlug });
  const serverNow = useEstimatedServerNow(overview?.serverNow);
  const catalog = useQuery(
    api.synesthesiaConfiguration.catalog,
    overview?.canReadCatalog ? { eventSlug } : "skip",
  );
  const [selectedWindowId, setSelectedWindowId] = useState<SynesthesiaWindow["id"] | null>(null);

  const queueWindows = (overview?.windows.filter((window) => window.canReadQueue) ?? []).sort(
    (left, right) =>
      windowOrder[left.status] - windowOrder[right.status] || left.startsAt - right.startsAt,
  );
  const selectedWindow =
    queueWindows.find((window) => window.id === selectedWindowId) ?? queueWindows[0];
  const queue = useQuery(
    api.synesthesiaOperations.queue,
    selectedWindow ? { eventSlug, windowId: selectedWindow.id } : "skip",
  );
  const voteCounts = useQuery(
    api.synesthesiaOperations.voteCounts,
    selectedWindow ? { eventSlug, windowId: selectedWindow.id } : "skip",
  );

  if (overview === undefined) {
    return (
      <section className="synesthesia-operations-shell">
        <LoadingLabel>Opening the music desk</LoadingLabel>
        <SkeletonCard lines={3} />
        <SkeletonList rows={4} />
      </section>
    );
  }

  const openWindows = overview.windows.filter((window) => window.status === "published");
  const draftWindows = overview.windows.filter((window) => window.status === "draft");
  const undecided = queue?.requests.filter((request) => request.state === "pending").length ?? 0;
  const unansweredReports =
    queue?.requests.reduce((total, request) => total + request.openReportCount, 0) ?? 0;
  const blocker = queue ? playbackBlocker(queue) : null;
  const queueIsCurrent =
    queue !== undefined &&
    voteCounts !== undefined &&
    selectedWindow !== undefined &&
    queue.window.id === selectedWindow.id &&
    voteCounts.windowId === selectedWindow.id;
  const queueRequests: QueueRequest[] = queueIsCurrent
    ? mergeSynesthesiaVoteCounts(queue.requests, voteCounts.counts)
    : [];

  return (
    <section className="synesthesia-operations-shell">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Shared room ambience</p>
          <h1>Music desk</h1>
          <p className="muted">
            Open song requests, approve them, and mark what is playing. Audio stays in the music
            app.
          </p>
        </div>
      </div>

      <section className="stage-block">
        {overview.windows.length === 0 ? (
          <>
            <p>Nothing is running at this desk yet.</p>
            <p className="muted">
              {overview.canCreateWindow
                ? "Create and publish a window to start."
                : "No music window is assigned to this account."}
            </p>
          </>
        ) : openWindows.length === 0 ? (
          <>
            <p>
              No window is open to participants
              {draftWindows.length > 0
                ? `, and ${draftWindows.length === 1 ? "one window is" : `${draftWindows.length} windows are`} still a draft.`
                : "."}
            </p>
            <p className="muted">Publish a draft to start taking requests.</p>
          </>
        ) : !queueIsCurrent ? (
          <>
            <p>
              {openWindows.length === 1
                ? "One window is open to participants."
                : `${openWindows.length} windows are open to participants.`}
            </p>
          </>
        ) : (
          <>
            <p>
              {undecided === 0
                ? `${selectedWindow.name}: no request is waiting for your decision.`
                : `${selectedWindow.name}: ${undecided === 1 ? "1 request is" : `${undecided} requests are`} waiting for your decision.`}
              {unansweredReports > 0
                ? ` ${unansweredReports === 1 ? "1 song has an unanswered report" : `${unansweredReports} songs have unanswered reports`}.`
                : ""}
            </p>
            <p className="muted">Approve a request to add it to the queue.</p>
          </>
        )}
      </section>

      <WindowSection overview={overview} serverNow={serverNow} />

      <section className="synesthesia-section" aria-labelledby="synesthesia-queue-title">
        <div className="section-heading">
          <div>
            <h2 id="synesthesia-queue-title">Live queue</h2>
          </div>
          {queueWindows.length > 1 ? (
            <label className="filter">
              <span>Window</span>
              <select
                value={selectedWindow?.id ?? ""}
                onChange={(event) => {
                  const window = queueWindows.find(
                    (candidate) => candidate.id === event.target.value,
                  );
                  if (window) setSelectedWindowId(window.id);
                }}
              >
                {queueWindows.map((window) => (
                  <option value={window.id} key={window.id}>
                    {window.name} · {synesthesiaWindowStatusLabels[window.status]}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>

        <p className="section-note">
          Approve a request to queue it, then mark it playing and played.
        </p>

        {queueWindows.length === 0 ? (
          <div className="health-empty">
            <strong>No queue yet.</strong>
            <span>
              {overview.windows.length === 0
                ? "Publish a window first."
                : "This account cannot read any window’s queue."}
            </span>
          </div>
        ) : queue === undefined || !selectedWindow ? (
          <>
            <LoadingLabel>Loading the request queue</LoadingLabel>
            <SkeletonList rows={4} />
          </>
        ) : (
          <>
            <div className="synesthesia-live-state">
              <span>{queue.window.playbackPaused ? "Playback paused" : "Playback open"}</span>
              <span>
                {new Date(queue.window.startsAt).toLocaleString()} –{" "}
                {new Date(queue.window.endsAt).toLocaleString()}
              </span>
              {queue.window.playbackPauseReason ? (
                <small>{queue.window.playbackPauseReason}</small>
              ) : null}
            </div>
            {blocker ? <p className="notice">{blocker}</p> : null}
            <SynesthesiaHostPlayer queue={queue} requests={queueRequests} serverNow={serverNow} />
            <div className="synesthesia-request-list">
              {queueRequests.map((request) => {
                const anotherRequestIsPlaying = queueRequests.some(
                  (candidate) => candidate.state === "playing" && candidate.id !== request.id,
                );
                const deferredUntilLater =
                  request.queueMode === "deferred" &&
                  request.scheduledFor !== undefined &&
                  request.scheduledFor > serverNow;
                return (
                  <SynesthesiaRequestCard
                    request={request}
                    startAvailable={
                      queue.window.status === "published" &&
                      !queue.window.playbackPaused &&
                      !anotherRequestIsPlaying &&
                      !deferredUntilLater
                    }
                    key={request.id}
                  />
                );
              })}
              {queueRequests.length === 0 ? (
                <div className="health-empty">
                  <strong>No requests yet.</strong>
                  <span>
                    {selectedWindow.status === "draft"
                      ? "Publish the window to start taking requests."
                      : selectedWindow.status === "closed"
                        ? "The window is closed."
                        : selectedWindow.requestsOpen
                          ? "New requests appear here for approval."
                          : "Requests are closed for this window. Reopen them on the window above."}
                  </span>
                </div>
              ) : null}
              {queue.truncated ? (
                <p className="notice">
                  This page shows the first {queue.requests.length} requests in the window. Clear
                  these before the rest can be read.
                </p>
              ) : null}
            </div>
          </>
        )}
      </section>

      {overview.canReadCatalog ? (
        <CatalogSection catalog={catalog} canManage={overview.canManageCatalog} />
      ) : (
        <section className="synesthesia-section">
          <h2>Available tracks</h2>
          <p className="muted">This account cannot read the track list.</p>
        </section>
      )}
    </section>
  );
}

function WindowSection({ overview, serverNow }: { overview: Overview; serverNow: number }) {
  const createWindow = useMutation(api.synesthesiaConfiguration.createWindow);
  const updateWindow = useMutation(api.synesthesiaConfiguration.updateWindow);
  const publishWindow = useMutation(api.synesthesiaConfiguration.publishWindow);
  const closeWindow = useMutation(api.synesthesiaConfiguration.closeWindow);
  const setPlaybackPause = useMutation(api.synesthesiaConfiguration.setPlaybackPause);
  const operations = useOperationRunner();
  const [editor, setEditor] = useState<WindowEditor | null>(null);
  const [action, setAction] = useState<WindowAction | null>(null);
  const [actionReason, setActionReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editorPending = operations.hasPending("synesthesia-window-save");
  const actionSlot = action ? `synesthesia-window-${action.kind}` : null;
  const actionPending = actionSlot !== null && operations.hasPending(actionSlot);
  const operationPending = editorPending || actionPending;

  const updateEditorValues = (values: WindowValues) => {
    if (operationPending || busy) return;
    setEditor((current) => (current ? { ...current, values } : null));
  };

  const chooseAction = (nextAction: WindowAction) => {
    if (operationPending || busy) return;
    setEditor(null);
    setAction(nextAction);
    setActionReason("");
    setError(null);
  };

  const submitEditor = async () => {
    if (!editor) return;
    const startsAt = timestampFromLocal(editor.values.startsAt);
    const endsAt = timestampFromLocal(editor.values.endsAt);
    const maxRequestsPerParticipant = integerFromValue(editor.values.maxRequestsPerParticipant);
    const maxVotesPerParticipant = integerFromValue(editor.values.maxVotesPerParticipant);
    const maxRequestsTotal = integerFromValue(editor.values.maxRequestsTotal);
    const maxTrackDurationSeconds = integerFromValue(editor.values.maxTrackDurationSeconds);
    if (
      startsAt === null ||
      endsAt === null ||
      maxRequestsPerParticipant === null ||
      maxVotesPerParticipant === null ||
      maxRequestsTotal === null ||
      maxTrackDurationSeconds === null
    ) {
      setError("Window times and limits must be valid whole numbers.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await operations.run("synesthesia-window-save", (clientOperationId) => async () => {
        const fields = {
          name: editor.values.name,
          kind: editor.values.kind,
          ...(editor.values.kind === "custom" && editor.values.customKindLabel.trim()
            ? { customKindLabel: editor.values.customKindLabel }
            : {}),
          startsAt,
          endsAt,
          requestsOpen: editor.values.requestsOpen,
          votingOpen: editor.values.votingOpen,
          catalogSourceLabel: editor.values.catalogSourceLabel,
          autoApproveRequests: editor.values.autoApproveRequests,
          maxRequestsPerParticipant,
          maxVotesPerParticipant,
          maxRequestsTotal,
          maxTrackDurationSeconds,
          allowExplicit: editor.values.allowExplicit,
          allowedEnergyTags: editor.values.allowedEnergyTags
            .split(",")
            .map((tag) => tag.trim())
            .filter(Boolean),
          reason: editor.values.reason,
          clientOperationId,
        };
        if (editor.mode === "create") {
          await createWindow({ eventSlug, ...fields });
        } else {
          await updateWindow({
            eventSlug,
            windowId: editor.windowId,
            expectedVersion: editor.expectedVersion,
            ...fields,
          });
        }
      });
      setEditor(null);
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setBusy(false);
    }
  };

  const submitAction = async () => {
    if (!action) return;
    setBusy(true);
    setError(null);
    try {
      await operations.run(`synesthesia-window-${action.kind}`, (clientOperationId) => async () => {
        const common = {
          eventSlug,
          windowId: action.windowId,
          expectedVersion: action.expectedVersion,
          reason: actionReason,
          clientOperationId,
        };
        if (action.kind === "publish") await publishWindow(common);
        else if (action.kind === "close") await closeWindow(common);
        else await setPlaybackPause({ ...common, paused: action.kind === "pause" });
      });
      setAction(null);
      setActionReason("");
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="synesthesia-section" aria-labelledby="synesthesia-windows-title">
      <div className="section-heading">
        <div>
          <h2 id="synesthesia-windows-title">Ambience windows</h2>
        </div>
        {overview.canCreateWindow && editor === null ? (
          <button
            type="button"
            className="secondary"
            disabled={operationPending || busy}
            onClick={() => setEditor({ mode: "create", values: initialWindowValues(serverNow) })}
          >
            New window
          </button>
        ) : null}
      </div>

      <p className="section-note">
        A window is a period when requests are open. Saving makes a draft; publishing opens
        requests.
      </p>

      <div className="synesthesia-window-list">
        {[...overview.windows]
          .sort(
            (left, right) =>
              windowOrder[left.status] - windowOrder[right.status] ||
              left.startsAt - right.startsAt,
          )
          .map((window) => (
            <article className="synesthesia-window" key={window.id}>
              <div className="synesthesia-window-heading">
                <div>
                  <strong>{window.name}</strong>
                  <span>
                    {window.kind === "custom" && window.customKindLabel
                      ? window.customKindLabel
                      : synesthesiaWindowKindLabels[window.kind]}
                    {" · "}
                    {synesthesiaWindowStatusLabels[window.status]}
                  </span>
                </div>
                <small>
                  {new Date(window.startsAt).toLocaleString()} –{" "}
                  {new Date(window.endsAt).toLocaleString()}
                </small>
              </div>
              <p>{windowConsequence(window)}</p>
              <p>
                {window.catalogSourceLabel} · {window.maxRequestsPerParticipant} requests/person ·{" "}
                {window.maxVotesPerParticipant} votes/person · {window.maxRequestsTotal} total
              </p>
              <p>
                {window.requestsOpen ? "Requests open" : "Requests closed"} ·{" "}
                {window.votingOpen ? "Voting open" : "Voting closed"} ·{" "}
                {window.autoApproveRequests
                  ? "Requests from the allowed list are approved automatically"
                  : "Every request waits for a decision at this desk"}
              </p>
              <div className="synesthesia-window-actions">
                {window.status === "draft" && window.canManage ? (
                  <button
                    type="button"
                    className="text-button"
                    disabled={operationPending || busy}
                    onClick={() => {
                      setEditor({
                        mode: "edit",
                        windowId: window.id,
                        expectedVersion: window.version,
                        values: valuesForWindow(window),
                      });
                      setAction(null);
                      setError(null);
                    }}
                  >
                    Edit
                  </button>
                ) : null}
                {window.status === "draft" && window.canPublish ? (
                  <button
                    type="button"
                    className="text-button"
                    disabled={operationPending || busy}
                    onClick={() =>
                      chooseAction({
                        windowId: window.id,
                        expectedVersion: window.version,
                        kind: "publish",
                      })
                    }
                  >
                    Publish
                  </button>
                ) : null}
                {window.status === "published" && window.canPausePlayback ? (
                  <button
                    type="button"
                    className="text-button"
                    disabled={operationPending || busy}
                    onClick={() =>
                      chooseAction({
                        windowId: window.id,
                        expectedVersion: window.version,
                        kind: window.playbackPaused ? "resume" : "pause",
                      })
                    }
                  >
                    {window.playbackPaused ? "Resume playback" : "Pause playback"}
                  </button>
                ) : null}
                {window.status === "published" && window.canManage ? (
                  <button
                    type="button"
                    className="text-button"
                    disabled={operationPending || busy}
                    onClick={() =>
                      chooseAction({
                        windowId: window.id,
                        expectedVersion: window.version,
                        kind: "close",
                      })
                    }
                  >
                    Close
                  </button>
                ) : null}
              </div>
            </article>
          ))}
        {overview.windows.length === 0 ? (
          <div className="health-empty">
            <strong>No window yet.</strong>
            <span>
              {overview.canCreateWindow
                ? "Create one for each period music is open: arrival, the working session, late night."
                : "An organizer with window access has to create one."}
            </span>
          </div>
        ) : null}
      </div>

      {editor ? (
        <form
          className="synesthesia-editor"
          onSubmit={(event) => {
            event.preventDefault();
            void submitEditor();
          }}
        >
          <div>
            <p className="eyebrow">{editor.mode === "create" ? "New draft" : "Edit draft"}</p>
            <h2>{editor.mode === "create" ? "Create ambience window" : editor.values.name}</h2>
            <p className="section-note">
              Saving leaves the window as a draft. Nobody outside this desk can see it, and no
              request can arrive, until you publish it. The limits below are per participant for the
              life of this window, and only tracks on the allowed list can be requested.
            </p>
          </div>
          <fieldset disabled={operationPending || busy} style={{ display: "contents" }}>
            <div className="synesthesia-editor-grid">
              <label className="field">
                <span>Name</span>
                <input
                  value={editor.values.name}
                  minLength={2}
                  maxLength={80}
                  required
                  onChange={(event) =>
                    updateEditorValues({ ...editor.values, name: event.target.value })
                  }
                />
              </label>
              <label className="field">
                <span>Kind</span>
                <select
                  value={editor.values.kind}
                  onChange={(event) => {
                    const kind = windowKindFromValue(event.target.value);
                    if (kind) updateEditorValues({ ...editor.values, kind });
                  }}
                >
                  {windowKinds.map((kind) => (
                    <option key={kind} value={kind}>
                      {synesthesiaWindowKindLabels[kind]}
                    </option>
                  ))}
                </select>
              </label>
              {editor.values.kind === "custom" ? (
                <label className="field">
                  <span>Other</span>
                  <input
                    value={editor.values.customKindLabel}
                    maxLength={60}
                    required
                    onChange={(event) =>
                      updateEditorValues({ ...editor.values, customKindLabel: event.target.value })
                    }
                  />
                </label>
              ) : null}
              <label className="field">
                <span>Starts</span>
                <input
                  type="datetime-local"
                  value={editor.values.startsAt}
                  required
                  onChange={(event) =>
                    updateEditorValues({ ...editor.values, startsAt: event.target.value })
                  }
                />
              </label>
              <label className="field">
                <span>Ends</span>
                <input
                  type="datetime-local"
                  value={editor.values.endsAt}
                  required
                  onChange={(event) =>
                    updateEditorValues({ ...editor.values, endsAt: event.target.value })
                  }
                />
              </label>
              <label className="field">
                <span>Music service</span>
                <input
                  value={editor.values.catalogSourceLabel}
                  minLength={2}
                  maxLength={100}
                  required
                  placeholder="Event Spotify account"
                  onChange={(event) =>
                    updateEditorValues({ ...editor.values, catalogSourceLabel: event.target.value })
                  }
                />
              </label>
              <label className="field">
                <span>Allowed moods</span>
                <input
                  value={editor.values.allowedEnergyTags}
                  required
                  placeholder="calm, focused, upbeat"
                  onChange={(event) =>
                    updateEditorValues({ ...editor.values, allowedEnergyTags: event.target.value })
                  }
                />
              </label>
              <label className="field">
                <span>Requests per participant</span>
                <input
                  type="number"
                  min="0"
                  max="10"
                  value={editor.values.maxRequestsPerParticipant}
                  required
                  onChange={(event) =>
                    updateEditorValues({
                      ...editor.values,
                      maxRequestsPerParticipant: event.target.value,
                    })
                  }
                />
              </label>
              <label className="field">
                <span>Votes per participant</span>
                <input
                  type="number"
                  min="0"
                  max="50"
                  value={editor.values.maxVotesPerParticipant}
                  required
                  onChange={(event) =>
                    updateEditorValues({
                      ...editor.values,
                      maxVotesPerParticipant: event.target.value,
                    })
                  }
                />
              </label>
              <label className="field">
                <span>Total requests</span>
                <input
                  type="number"
                  min="1"
                  max="200"
                  value={editor.values.maxRequestsTotal}
                  required
                  onChange={(event) =>
                    updateEditorValues({ ...editor.values, maxRequestsTotal: event.target.value })
                  }
                />
              </label>
              <label className="field">
                <span>Maximum track seconds</span>
                <input
                  type="number"
                  min="60"
                  max="900"
                  value={editor.values.maxTrackDurationSeconds}
                  required
                  onChange={(event) =>
                    updateEditorValues({
                      ...editor.values,
                      maxTrackDurationSeconds: event.target.value,
                    })
                  }
                />
              </label>
            </div>
            <div className="synesthesia-checks">
              <label>
                <input
                  type="checkbox"
                  checked={editor.values.requestsOpen}
                  onChange={(event) =>
                    updateEditorValues({ ...editor.values, requestsOpen: event.target.checked })
                  }
                />{" "}
                Requests open
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={editor.values.votingOpen}
                  onChange={(event) =>
                    updateEditorValues({ ...editor.values, votingOpen: event.target.checked })
                  }
                />{" "}
                Voting open
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={editor.values.autoApproveRequests}
                  onChange={(event) =>
                    updateEditorValues({
                      ...editor.values,
                      autoApproveRequests: event.target.checked,
                    })
                  }
                />{" "}
                Approve requests for listed tracks automatically
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={editor.values.allowExplicit}
                  onChange={(event) =>
                    updateEditorValues({ ...editor.values, allowExplicit: event.target.checked })
                  }
                />{" "}
                Allow explicit tracks
              </label>
            </div>
            <label className="field">
              <span>Reason (kept on record)</span>
              <textarea
                value={editor.values.reason}
                minLength={5}
                maxLength={200}
                required
                onChange={(event) =>
                  updateEditorValues({ ...editor.values, reason: event.target.value })
                }
              />
            </label>
          </fieldset>
          <div className="synesthesia-command-actions">
            <button
              type="button"
              className="text-button"
              disabled={busy || operationPending}
              onClick={() => {
                setEditor(null);
                setError(null);
              }}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="primary"
              disabled={
                busy || actionPending || (!editorPending && editor.values.reason.trim().length < 5)
              }
            >
              {busy ? "Saving…" : editorPending ? "Confirm earlier draft" : "Save draft"}
            </button>
          </div>
          {error ? (
            <p className="notice error" role="alert">
              {error}
            </p>
          ) : null}
        </form>
      ) : null}

      {action ? (
        <form
          className="synesthesia-command window-command"
          onSubmit={(event) => {
            event.preventDefault();
            void submitAction();
          }}
        >
          <strong>
            {action.kind === "publish"
              ? "Publish this window"
              : action.kind === "close"
                ? "Close this window"
                : action.kind === "pause"
                  ? "Pause playback"
                  : "Resume playback"}
          </strong>
          <label className="field">
            <span>Reason (kept on record)</span>
            <textarea
              disabled={operationPending || busy}
              value={actionReason}
              minLength={5}
              maxLength={200}
              required
              onChange={(event) => setActionReason(event.target.value)}
            />
          </label>
          <div className="synesthesia-command-actions">
            <button
              type="button"
              className="text-button"
              disabled={busy || operationPending}
              onClick={() => {
                setAction(null);
                setActionReason("");
                setError(null);
              }}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="secondary"
              disabled={busy || editorPending || (!actionPending && actionReason.trim().length < 5)}
            >
              {busy ? "Saving…" : actionPending ? "Confirm earlier action" : "Confirm"}
            </button>
          </div>
          {error ? (
            <p className="notice error" role="alert">
              {error}
            </p>
          ) : null}
        </form>
      ) : null}
    </section>
  );
}

function CatalogSection({
  catalog,
  canManage,
}: {
  catalog: CatalogResult | undefined;
  canManage: boolean;
}) {
  const addTrack = useMutation(api.synesthesiaConfiguration.addCatalogTrack);
  const updateTrack = useMutation(api.synesthesiaConfiguration.updateCatalogTrack);
  const operations = useOperationRunner();
  const [editor, setEditor] = useState<CatalogEditor | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savePending = operations.hasPending("synesthesia-catalog-save");

  const updateValues = (values: CatalogValues) => {
    if (savePending || busy) return;
    setEditor((current) => (current ? { ...current, values } : null));
  };

  const submit = async () => {
    if (!editor) return;
    const durationSeconds = integerFromValue(editor.values.durationSeconds);
    if (durationSeconds === null) {
      setError("Track duration must be a whole number of seconds.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await operations.run("synesthesia-catalog-save", (clientOperationId) => async () => {
        const fields = {
          title: editor.values.title,
          artist: editor.values.artist,
          ...(editor.values.album.trim() ? { album: editor.values.album } : {}),
          durationSeconds,
          isExplicit: editor.values.isExplicit,
          energyTag: editor.values.energyTag,
          reason: editor.values.reason,
          clientOperationId,
        };
        if (editor.mode === "create") {
          await addTrack({
            eventSlug,
            provider: editor.values.provider,
            providerTrackId: editor.values.providerTrackId,
            ...fields,
          });
        } else {
          await updateTrack({
            eventSlug,
            trackId: editor.trackId,
            status: editor.values.status,
            expectedVersion: editor.expectedVersion,
            ...fields,
          });
        }
      });
      setEditor(null);
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="synesthesia-section" aria-labelledby="synesthesia-catalog-title">
      <div className="section-heading">
        <div>
          <h2 id="synesthesia-catalog-title">Available tracks</h2>
        </div>
        {canManage && editor === null ? (
          <button
            type="button"
            className="secondary"
            disabled={savePending || busy}
            onClick={() => {
              setEditor({ mode: "create", values: emptyCatalogValues() });
              setError(null);
            }}
          >
            Add track
          </button>
        ) : null}
      </div>

      <p className="section-note">
        {catalog === undefined || catalog.tracks.length === 0
          ? "Participants can only request songs on this list."
          : `${countLabel(requestableCount(catalog), "track")} can be requested${
              catalog.tracks.length > requestableCount(catalog)
                ? `, and ${catalog.tracks.length - requestableCount(catalog)} have been withdrawn and cannot.`
                : "."
            } Each window can narrow this list further.`}
      </p>

      {catalog === undefined ? (
        <>
          <LoadingLabel>Loading the track list</LoadingLabel>
          <SkeletonList rows={4} />
        </>
      ) : (
        <div className="synesthesia-catalog-list">
          {[...catalog.tracks]
            .sort((left, right) => catalogOrder(left) - catalogOrder(right))
            .map((track) => (
              <div className="synesthesia-catalog-track" key={track.id}>
                <div>
                  <strong>{track.title}</strong>
                  <span>
                    {track.artist} · {track.provider} · {track.durationSeconds}s · {track.energyTag}
                  </span>
                </div>
                <div>
                  <small>
                    {synesthesiaCatalogTrackStatusLabels[track.status]}
                    {track.isExplicit ? " · explicit" : ""}
                  </small>
                  {canManage ? (
                    <button
                      type="button"
                      className="text-button"
                      disabled={savePending || busy}
                      onClick={() => {
                        setEditor({
                          mode: "edit",
                          trackId: track.id,
                          expectedVersion: track.version,
                          values: {
                            provider: track.provider,
                            providerTrackId: track.providerTrackId,
                            title: track.title,
                            artist: track.artist,
                            album: track.album ?? "",
                            durationSeconds: String(track.durationSeconds),
                            isExplicit: track.isExplicit,
                            energyTag: track.energyTag,
                            status: track.status,
                            reason: "",
                          },
                        });
                        setError(null);
                      }}
                    >
                      Edit
                    </button>
                  ) : null}
                </div>
              </div>
            ))}
          {catalog.tracks.length === 0 ? (
            <div className="health-empty">
              <strong>No tracks yet.</strong>
              <span>
                {canManage
                  ? "Participants can only request what is listed here."
                  : "Adding tracks needs the catalog-manage permission."}
              </span>
            </div>
          ) : null}
          {catalog.truncated ? (
            <p className="notice">
              This list can hold 500 tracks. Remove one before adding another.
            </p>
          ) : null}
        </div>
      )}

      {editor ? (
        <form
          className="synesthesia-editor"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div>
            <p className="eyebrow">
              {editor.mode === "create" ? "New catalog track" : "Edit catalog track"}
            </p>
            <h2>{editor.mode === "create" ? "Add track" : editor.values.title}</h2>
          </div>
          {editor.mode === "create" ? (
            <YouTubeTrackFinder
              disabled={savePending || busy}
              onPick={(video) =>
                updateValues({
                  ...editor.values,
                  provider: "youtube",
                  providerTrackId: video.videoId,
                  title: video.title,
                  artist: video.channelTitle,
                  durationSeconds: String(video.durationSeconds),
                  isExplicit: video.ageRestricted,
                  energyTag: editor.values.energyTag || "unclassified",
                })
              }
            />
          ) : null}
          <fieldset disabled={savePending || busy} style={{ display: "contents" }}>
            <div className="synesthesia-editor-grid">
              {editor.mode === "create" ? (
                <>
                  <label className="field">
                    <span>Provider</span>
                    <input
                      value={editor.values.provider}
                      maxLength={40}
                      required
                      placeholder="spotify"
                      onChange={(event) =>
                        updateValues({ ...editor.values, provider: event.target.value })
                      }
                    />
                  </label>
                  <label className="field">
                    <span>Track ID in the music service</span>
                    <input
                      value={editor.values.providerTrackId}
                      maxLength={180}
                      required
                      onChange={(event) =>
                        updateValues({ ...editor.values, providerTrackId: event.target.value })
                      }
                    />
                  </label>
                </>
              ) : (
                <p className="synesthesia-source-readout">
                  {editor.values.provider} · {editor.values.providerTrackId}
                </p>
              )}
              <label className="field">
                <span>Title</span>
                <input
                  value={editor.values.title}
                  maxLength={120}
                  required
                  onChange={(event) =>
                    updateValues({ ...editor.values, title: event.target.value })
                  }
                />
              </label>
              <label className="field">
                <span>Artist</span>
                <input
                  value={editor.values.artist}
                  maxLength={120}
                  required
                  onChange={(event) =>
                    updateValues({ ...editor.values, artist: event.target.value })
                  }
                />
              </label>
              <label className="field">
                <span>Album, if useful</span>
                <input
                  value={editor.values.album}
                  maxLength={120}
                  onChange={(event) =>
                    updateValues({ ...editor.values, album: event.target.value })
                  }
                />
              </label>
              <label className="field">
                <span>Duration in seconds</span>
                <input
                  type="number"
                  min="30"
                  max="1800"
                  value={editor.values.durationSeconds}
                  required
                  onChange={(event) =>
                    updateValues({ ...editor.values, durationSeconds: event.target.value })
                  }
                />
              </label>
              <label className="field">
                <span>Mood</span>
                <input
                  value={editor.values.energyTag}
                  maxLength={32}
                  required
                  placeholder="focused"
                  onChange={(event) =>
                    updateValues({ ...editor.values, energyTag: event.target.value })
                  }
                />
              </label>
              {editor.mode === "edit" ? (
                <label className="field">
                  <span>Can participants request it?</span>
                  <select
                    value={editor.values.status}
                    onChange={(event) =>
                      updateValues({
                        ...editor.values,
                        status: event.target.value === "disabled" ? "disabled" : "active",
                      })
                    }
                  >
                    <option value="active">{synesthesiaCatalogTrackStatusLabels.active}</option>
                    <option value="disabled">{synesthesiaCatalogTrackStatusLabels.disabled}</option>
                  </select>
                </label>
              ) : null}
            </div>
            <label className="synesthesia-check">
              <input
                type="checkbox"
                checked={editor.values.isExplicit}
                onChange={(event) =>
                  updateValues({ ...editor.values, isExplicit: event.target.checked })
                }
              />{" "}
              Explicit track
            </label>
            <label className="field">
              <span>Reason (kept on record)</span>
              <textarea
                value={editor.values.reason}
                minLength={5}
                maxLength={200}
                required
                onChange={(event) => updateValues({ ...editor.values, reason: event.target.value })}
              />
            </label>
          </fieldset>
          <div className="synesthesia-command-actions">
            <button
              type="button"
              className="text-button"
              disabled={busy || savePending}
              onClick={() => {
                setEditor(null);
                setError(null);
              }}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="primary"
              disabled={busy || (!savePending && editor.values.reason.trim().length < 5)}
            >
              {busy ? "Saving…" : savePending ? "Confirm earlier track" : "Save track"}
            </button>
          </div>
          {error ? (
            <p className="notice error" role="alert">
              {error}
            </p>
          ) : null}
        </form>
      ) : null}
    </section>
  );
}

/** Searches YouTube from the desk and hands a result to the track editor. */
function YouTubeTrackFinder({
  disabled,
  onPick,
}: {
  disabled: boolean;
  onPick: (video: YouTubeVideo) => void;
}) {
  const search = useAction(api.synesthesiaYouTube.search);
  const [query, setQuery] = useState("");
  const [outcome, setOutcome] = useState<
    { query: string; videos: YouTubeVideo[] } | { query: string; failure: string } | null
  >(null);
  const trimmed = query.trim();
  const activeQuery = trimmed.length >= 2 ? trimmed : null;
  const searching = activeQuery !== null && outcome?.query !== activeQuery;

  useEffect(() => {
    if (activeQuery === null) return;
    const timer = window.setTimeout(() => {
      search({ eventSlug, query: activeQuery })
        .then((videos) => setOutcome({ query: activeQuery, videos }))
        .catch((caught: unknown) =>
          setOutcome({ query: activeQuery, failure: readableError(caught) }),
        );
    }, 450);
    return () => window.clearTimeout(timer);
  }, [activeQuery, search]);

  const current = activeQuery !== null && outcome?.query === activeQuery ? outcome : null;

  return (
    <div className="synesthesia-finder">
      <label className="field">
        <span>Find on YouTube</span>
        <input
          type="search"
          value={query}
          disabled={disabled}
          maxLength={80}
          placeholder="Title or artist"
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      {searching ? <p className="muted">Searching…</p> : null}
      {current && "failure" in current ? <p className="notice error">{current.failure}</p> : null}
      {current && "videos" in current ? (
        current.videos.length === 0 ? (
          <p className="muted">No playable videos match.</p>
        ) : (
          <div className="synesthesia-finder-list">
            {current.videos.map((video) => (
              <div className="synesthesia-catalog-track" key={video.videoId}>
                <div>
                  <strong>{video.title}</strong>
                  <span>
                    {video.channelTitle} · {video.durationSeconds}s
                    {video.ageRestricted ? " · age-restricted" : ""}
                  </span>
                </div>
                <button
                  type="button"
                  className="text-button"
                  disabled={disabled}
                  onClick={() => onPick(video)}
                >
                  Use
                </button>
              </div>
            ))}
          </div>
        )
      ) : null}
    </div>
  );
}

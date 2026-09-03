import { api } from "@code2create/backend/api";
import type { FunctionReturnType } from "convex/server";
import { useMutation } from "convex/react";
import { useEffect, useRef, useState } from "react";

import { eventSlug } from "../lib/config";
import { readableError } from "../lib/errors";
import { useOperationRunner } from "../lib/operations";
import { useYouTubePlayer } from "../lib/useYouTubePlayer";

type QueueResult = FunctionReturnType<typeof api.synesthesiaOperations.queue>;
type QueueRequest = QueueResult["requests"][number] & { voteCount: number };
type PlaybackAction = "start" | "played" | "skip";

function isYouTube(request: QueueRequest) {
  return request.provider === "youtube";
}

/**
 * The venue's player. Whoever hosts turns it on from the device wired to the
 * speakers; it plays whatever is marked playing, records the finish, and
 * starts the next request in queue order.
 */
export function SynesthesiaHostPlayer({
  queue,
  requests,
  serverNow,
}: {
  queue: QueueResult;
  requests: readonly QueueRequest[];
  serverNow: number;
}) {
  const acknowledge = useMutation(api.synesthesiaOperations.acknowledgePlayback);
  const operations = useOperationRunner();
  const [hosting, setHosting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const playing = requests.find((request) => request.state === "playing") ?? null;
  const next =
    requests.find(
      (request) =>
        (request.state === "queued" || request.state === "approved") &&
        isYouTube(request) &&
        !(
          request.queueMode === "deferred" &&
          request.scheduledFor !== undefined &&
          request.scheduledFor > serverNow
        ),
    ) ?? null;
  const canDrive = requests.some((request) => request.canAcknowledgePlayback);
  const windowOpen = queue.window.status === "published" && !queue.window.playbackPaused;
  const videoId = playing && isYouTube(playing) ? playing.providerTrackId : null;

  const acknowledgeRequest = (request: QueueRequest, action: PlaybackAction, reason: string) =>
    operations.run(
      `host-${action}-${request.id}`,
      (clientOperationId) => () =>
        acknowledge({
          eventSlug,
          requestId: request.id,
          action,
          expectedVersion: request.version,
          reason,
          clientOperationId,
        }),
    );

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setBusy(false);
    }
  };

  const advance = () =>
    run(async () => {
      if (playing) await acknowledgeRequest(playing, "played", "Finished in the host player");
      if (next && windowOpen)
        await acknowledgeRequest(next, "start", "Host player started the next request");
    });

  const skipBroken = () =>
    run(async () => {
      if (playing)
        await acknowledgeRequest(playing, "skip", "The host player could not play this video");
    });

  const { container, state } = useYouTubePlayer({
    enabled: hosting,
    videoId,
    onEnded: () => void advance(),
    onError: () => void skipBroken(),
  });

  // While hosting, an idle desk with something approved starts it on its own;
  // a click is only needed once, to let the browser play sound.
  const advanceRef = useRef(advance);
  useEffect(() => {
    advanceRef.current = advance;
  });
  const idleWithNext = hosting && !playing && next !== null && windowOpen && canDrive;
  const nextId = next?.id ?? null;
  useEffect(() => {
    if (!idleWithNext || busy) return;
    const timer = window.setTimeout(() => void advanceRef.current(), 600);
    return () => window.clearTimeout(timer);
  }, [idleWithNext, nextId, busy]);

  if (!canDrive && !playing) return null;

  return (
    <section className="synesthesia-host" aria-labelledby="synesthesia-host-title">
      <div className="synesthesia-host-heading">
        <div>
          <h3 id="synesthesia-host-title">Host player</h3>
          <p className="muted">
            Audio plays on this device. Host from the machine wired to the venue speakers; it marks
            each track played and starts the next one.
          </p>
        </div>
        {canDrive ? (
          <button
            type="button"
            className={hosting ? "secondary" : "primary"}
            disabled={busy}
            onClick={() => setHosting((value) => !value)}
          >
            {hosting ? "Stop hosting" : "Host from this device"}
          </button>
        ) : null}
      </div>

      {hosting ? (
        <div className="synesthesia-host-frame" ref={container} />
      ) : (
        <div className="synesthesia-host-frame idle">
          {playing ? `Playing elsewhere: ${playing.title}` : "Not hosting from this device."}
        </div>
      )}

      <p className="synesthesia-host-status">
        {playing ? (
          <>
            <strong>{playing.title}</strong> · {playing.artist}
            {isYouTube(playing)
              ? hosting
                ? ` · player ${state}`
                : ""
              : " · not a YouTube track, play it in the licensed app"}
          </>
        ) : next ? (
          <>
            Up next: <strong>{next.title}</strong> · {next.artist}
          </>
        ) : (
          "Nothing is queued for the player."
        )}
      </p>

      {canDrive ? (
        <div className="synesthesia-host-actions">
          {!playing && next && windowOpen ? (
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() => void advance()}
            >
              {busy ? "Starting…" : "Play next"}
            </button>
          ) : null}
          {playing ? (
            <>
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => void advance()}
              >
                {busy ? "Working…" : next && windowOpen ? "Played, start next" : "Mark played"}
              </button>
              <button
                type="button"
                className="text-button"
                disabled={busy}
                onClick={() => void skipBroken()}
              >
                Skip
              </button>
            </>
          ) : null}
          {!windowOpen ? (
            <span className="muted">Playback is paused or the window is not open.</span>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <p className="notice error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

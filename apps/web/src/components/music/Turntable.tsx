import { useEffect, useId, useRef, useState } from "react";

import type { MusicRequestView } from "../dashboard/MusicTile";
import type { TurntablePlayback, TurntableScene } from "./turntableScene";

export function Turntable({ track, paused }: { track: MusicRequestView | null; paused: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<TurntableScene | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "unavailable">("loading");
  const instructionsId = useId();
  const playback: TurntablePlayback = {
    title: track?.title ?? "Between tracks",
    artist: track?.artist ?? "Code2Create",
    playing: track !== null && !paused,
    startedAt: track?.playbackStartedAt,
    durationSeconds: track?.durationSeconds ?? 0,
  };
  const latestPlayback = useRef(playback);

  useEffect(() => {
    latestPlayback.current = playback;
    sceneRef.current?.setPlayback(playback);
  });

  useEffect(() => {
    let cancelled = false;
    function unavailable() {
      if (cancelled) return;
      sceneRef.current?.dispose();
      sceneRef.current = null;
      setStatus("unavailable");
    }
    void import("./turntableScene").then(({ createTurntableScene }) => {
      if (cancelled || !canvasRef.current) return;
      const scene = createTurntableScene(canvasRef.current, unavailable);
      sceneRef.current = scene;
      scene.setPlayback(latestPlayback.current);
      setStatus("ready");
    }).catch(unavailable);

    return () => {
      cancelled = true;
      sceneRef.current?.dispose();
      sceneRef.current = null;
    };
  }, []);

  const controlClass = "flex size-9 items-center justify-center rounded-full border border-rose/25 bg-wash/35 text-fg/60 transition-colors hover:border-rose/60 hover:text-rose-light focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-light";

  return (
    <div className="music-turntable-stage">
      <div className="absolute inset-0">
        <canvas
          ref={canvasRef}
          role="group"
          aria-label="Interactive 3D turntable"
          aria-describedby={instructionsId}
          aria-busy={status === "loading"}
          tabIndex={status === "ready" ? 0 : -1}
          className={`block size-full cursor-grab outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-rose/65 ${status === "ready" ? "opacity-100" : "opacity-0"}`}
        />
        {status !== "ready" ? (
          <div role="status" className="pointer-events-none absolute inset-0 grid place-items-center px-8 text-center text-[12px] text-fg/50">
            {status === "loading" ? "Setting up the turntable…" : "The 3D turntable is unavailable on this device."}
          </div>
        ) : null}
      </div>
      <div id={instructionsId} className="sr-only">
        Drag the deck to rotate the view, or drag the vinyl to spin it. Scroll or pinch to zoom.
        With the turntable focused, use the arrow keys to rotate, plus and minus to zoom,
        Space to spin the record, and Home to reset the view. These controls change the visual only.
      </div>
      {status === "ready" ? (
        <div className="music-turntable-controls">
          <div role="group" aria-label="Turntable view controls" className="flex gap-1.5">
            <button type="button" className={controlClass} onClick={() => sceneRef.current?.spinRecord()} aria-label="Spin the record" title="Spin the record">
              <svg aria-hidden viewBox="0 0 20 20" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.3">
                <circle cx="10" cy="10" r="7" /><circle cx="10" cy="10" r="2" /><path d="M5 8a5.4 5.4 0 0 1 3-3m4 10a5.4 5.4 0 0 0 3-3" />
              </svg>
            </button>
            <button type="button" className={controlClass} onClick={() => sceneRef.current?.zoom("out")} aria-label="Zoom out" title="Zoom out">
              <svg aria-hidden viewBox="0 0 20 20" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.3"><path d="M5 10h10" /></svg>
            </button>
            <button type="button" className={controlClass} onClick={() => sceneRef.current?.zoom("in")} aria-label="Zoom in" title="Zoom in">
              <svg aria-hidden viewBox="0 0 20 20" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.3"><path d="M5 10h10m-5-5v10" /></svg>
            </button>
            <button type="button" className={controlClass} onClick={() => sceneRef.current?.resetView()} aria-label="Reset turntable view" title="Reset view">
              <svg aria-hidden viewBox="0 0 20 20" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.3"><path d="M4 8a6 6 0 1 1 0 5M4 3v5h5" /></svg>
            </button>
          </div>
          <p className="m-0 mt-2 text-center text-[10px] text-fg/40">Drag to explore · touch the vinyl</p>
        </div>
      ) : null}
    </div>
  );
}

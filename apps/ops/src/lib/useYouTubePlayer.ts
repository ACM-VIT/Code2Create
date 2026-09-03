import { useEffect, useRef, useState } from "react";

export type YouTubePlayerState =
  | "unstarted"
  | "ended"
  | "playing"
  | "paused"
  | "buffering"
  | "cued";

type Player = {
  loadVideoById: (videoId: string) => void;
  destroy: () => void;
};

type PlayerNamespace = {
  Player: new (
    element: HTMLElement,
    options: {
      width?: string;
      height?: string;
      playerVars?: Record<string, string | number>;
      events?: {
        onReady?: () => void;
        onStateChange?: (event: { data: number }) => void;
        onError?: (event: { data: number }) => void;
      };
    },
  ) => Player;
  PlayerState: Record<"UNSTARTED" | "ENDED" | "PLAYING" | "PAUSED" | "BUFFERING" | "CUED", number>;
};

declare global {
  interface Window {
    YT?: PlayerNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let apiLoading: Promise<PlayerNamespace> | null = null;

function loadPlayerApi() {
  const loaded = window.YT;
  if (loaded?.Player) return Promise.resolve(loaded);
  if (!apiLoading) {
    apiLoading = new Promise((resolve) => {
      const previous = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        previous?.();
        if (window.YT) resolve(window.YT);
      };
      const script = document.createElement("script");
      script.src = "https://www.youtube.com/iframe_api";
      script.async = true;
      document.head.append(script);
    });
  }
  return apiLoading;
}

/**
 * The host's YouTube player. It mounts only after a click (`enabled`), so
 * the browser lets it play with sound, and reports when a video ends or
 * cannot play so the desk can advance the queue.
 */
export function useYouTubePlayer({
  enabled,
  videoId,
  onEnded,
  onError,
}: {
  enabled: boolean;
  videoId: string | null;
  onEnded: () => void;
  onError: (code: number) => void;
}) {
  const container = useRef<HTMLDivElement | null>(null);
  const player = useRef<Player | null>(null);
  const loadedVideo = useRef<string | null>(null);
  const handlers = useRef({ onEnded, onError });
  const [ready, setReady] = useState(false);
  const [state, setState] = useState<YouTubePlayerState>("unstarted");

  useEffect(() => {
    handlers.current = { onEnded, onError };
  }, [onEnded, onError]);

  useEffect(() => {
    const host = container.current;
    if (!enabled || !host) return;
    let cancelled = false;
    const mount = document.createElement("div");
    host.append(mount);
    void loadPlayerApi().then((YT) => {
      if (cancelled) return;
      const names = new Map<number, YouTubePlayerState>([
        [YT.PlayerState.UNSTARTED, "unstarted"],
        [YT.PlayerState.ENDED, "ended"],
        [YT.PlayerState.PLAYING, "playing"],
        [YT.PlayerState.PAUSED, "paused"],
        [YT.PlayerState.BUFFERING, "buffering"],
        [YT.PlayerState.CUED, "cued"],
      ]);
      player.current = new YT.Player(mount, {
        width: "100%",
        height: "100%",
        playerVars: { autoplay: 1, controls: 1, rel: 0, playsinline: 1 },
        events: {
          onReady: () => setReady(true),
          onStateChange: (event) => {
            const next = names.get(event.data) ?? "unstarted";
            setState(next);
            if (next === "ended") handlers.current.onEnded();
          },
          onError: (event) => handlers.current.onError(event.data),
        },
      });
    });
    return () => {
      cancelled = true;
      player.current?.destroy();
      player.current = null;
      loadedVideo.current = null;
      mount.remove();
      setReady(false);
      setState("unstarted");
    };
  }, [enabled]);

  useEffect(() => {
    if (!ready || !player.current) return;
    if (videoId === null) {
      loadedVideo.current = null;
      return;
    }
    if (loadedVideo.current === videoId) return;
    loadedVideo.current = videoId;
    player.current.loadVideoById(videoId);
  }, [ready, videoId]);

  return { container, ready, state };
}

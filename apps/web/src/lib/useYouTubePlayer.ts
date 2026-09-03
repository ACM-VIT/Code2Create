import { useEffect, useRef, useState } from "react";

export type YouTubePlayerState = "unstarted" | "ended" | "playing" | "paused" | "buffering" | "cued";

type YouTubePlayer = {
  loadVideoById: (videoId: string) => void;
  mute: () => void;
  playVideo: () => void;
  destroy: () => void;
};

type YouTubeNamespace = {
  Player: new (
    element: HTMLElement,
    options: {
      width?: string | number;
      height?: string | number;
      videoId?: string;
      playerVars?: Record<string, string | number>;
      events?: {
        onReady?: () => void;
        onStateChange?: (event: { data: number }) => void;
        onError?: (event: { data: number }) => void;
      };
    },
  ) => YouTubePlayer;
  PlayerState: Record<"UNSTARTED" | "ENDED" | "PLAYING" | "PAUSED" | "BUFFERING" | "CUED", number>;
};

declare global {
  interface Window {
    YT?: YouTubeNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let apiPromise: Promise<YouTubeNamespace> | null = null;

function loadApi() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (!apiPromise) {
    apiPromise = new Promise((resolve) => {
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
  return apiPromise;
}

/**
 * A muted, looping YouTube player used as scenery. Reports its state so the
 * caller can veil it whenever YouTube would draw its own controls.
 */
export function useSceneryPlayer({ videoId }: { videoId: string | null }) {
  const container = useRef<HTMLDivElement | null>(null);
  const player = useRef<YouTubePlayer | null>(null);
  const loaded = useRef<string | null>(null);
  const [state, setState] = useState<YouTubePlayerState>("unstarted");

  useEffect(() => {
    const host = container.current;
    if (!host || videoId === null) return;
    let cancelled = false;
    const mount = document.createElement("div");
    host.append(mount);
    void loadApi().then((YT) => {
      if (cancelled) return;
      const names = new Map<number, YouTubePlayerState>([
        [YT.PlayerState.UNSTARTED, "unstarted"],
        [YT.PlayerState.ENDED, "ended"],
        [YT.PlayerState.PLAYING, "playing"],
        [YT.PlayerState.PAUSED, "paused"],
        [YT.PlayerState.BUFFERING, "buffering"],
        [YT.PlayerState.CUED, "cued"],
      ]);
      loaded.current = videoId;
      player.current = new YT.Player(mount, {
        width: "100%",
        height: "100%",
        videoId,
        playerVars: {
          autoplay: 1,
          mute: 1,
          controls: 0,
          loop: 1,
          playlist: videoId,
          playsinline: 1,
          rel: 0,
          iv_load_policy: 3,
          disablekb: 1,
          fs: 0,
        },
        events: {
          onReady: () => {
            player.current?.mute();
            player.current?.playVideo();
          },
          onStateChange: (event) => setState(names.get(event.data) ?? "unstarted"),
        },
      });
    });
    return () => {
      cancelled = true;
      player.current?.destroy();
      player.current = null;
      loaded.current = null;
      mount.remove();
      setState("unstarted");
    };
    // A new video means a new player; the id is the only input.
  }, [videoId]);

  return { container, state };
}

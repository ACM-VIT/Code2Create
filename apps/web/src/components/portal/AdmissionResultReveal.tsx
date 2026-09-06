import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import {
  admissionResultUsesChest,
  type AdmissionResultOutcome,
} from "../../lib/admissionResultReveal";
import { startChestAnimation } from "./ChestAnimation/startChestAnimation";
import { Petal } from "./Petal";
import { PortalButton } from "./PortalButton";
import { PortalScene } from "./PortalScene";
import "./admission-result-reveal.css";

const animationStartupTimeoutMs = 1_500;
const videoSafetyTimeoutMs = 4_300;
const staticFallbackDurationMs = 1_400;

type SelectedAnimationMode = "starting" | "webgpu" | "video" | "static";

const horizontalPetals = Array.from({ length: 17 }, (_, index) => {
  const left = `${index * 6.25}%`;
  const size = 42 + (index % 4) * 5;
  return [
    { left, top: "-7%", rotation: -52 + index * 19, size, delay: -(index % 6) * 0.24 },
    {
      left,
      top: "92%",
      rotation: 128 + index * 17,
      size: size + (index % 2) * 4,
      delay: -((index + 3) % 7) * 0.21,
    },
  ];
}).flat();

const verticalPetals = Array.from({ length: 9 }, (_, index) => {
  const top = `${8 + index * 10.5}%`;
  const size = 44 + (index % 3) * 6;
  return [
    { left: "-5%", top, rotation: 208 + index * 23, size, delay: -(index % 5) * 0.27 },
    {
      left: "94%",
      top,
      rotation: 32 + index * 21,
      size: size + (index % 2) * 3,
      delay: -((index + 2) % 6) * 0.23,
    },
  ];
}).flat();

const selectedCardPetals = [...horizontalPetals, ...verticalPetals];

const resultCopy: Record<
  AdmissionResultOutcome,
  { heading: string; message: (teamName: string) => string; action: string }
> = {
  selected: {
    heading: "You are selected for this hack!",
    message: (teamName) => `${teamName}, your team made the Code2Create shortlist.`,
    action: "See what’s next",
  },
  waitlisted: {
    heading: "You’re on the waitlist.",
    message: (teamName) =>
      `${teamName} is still in consideration. We’ll share an update if a place opens.`,
    action: "View your status",
  },
  not_selected: {
    heading: "Better luck next time",
    message: (teamName) => `Thank you, ${teamName}, for sharing your idea with Code2Create.`,
    action: "Continue",
  },
};

export function AdmissionResultReveal({
  outcome,
  eventName,
  teamName,
  header,
  onSignOut,
  onContinue,
}: {
  outcome: AdmissionResultOutcome;
  eventName: string;
  teamName: string;
  header?: ReactNode;
  onSignOut?: () => void;
  onContinue: () => void;
}) {
  const showsChest = admissionResultUsesChest(outcome);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chestArtRef = useRef<HTMLImageElement>(null);
  const revealTimerRef = useRef<number | null>(null);
  const [revealed, setRevealed] = useState(!showsChest);
  const [animationMode, setAnimationMode] =
    useState<SelectedAnimationMode>("starting");
  const [videoPlaying, setVideoPlaying] = useState(false);
  const copy = resultCopy[outcome];
  const reveal = useCallback(() => setRevealed(true), []);

  const clearRevealTimer = useCallback(() => {
    if (revealTimerRef.current === null) return;
    window.clearTimeout(revealTimerRef.current);
    revealTimerRef.current = null;
  }, []);

  const armVideoSafetyTimer = useCallback(() => {
    clearRevealTimer();
    revealTimerRef.current = window.setTimeout(reveal, videoSafetyTimeoutMs);
  }, [clearRevealTimer, reveal]);

  const beginStaticFallback = useCallback(() => {
    clearRevealTimer();
    setAnimationMode("static");
    revealTimerRef.current = window.setTimeout(reveal, staticFallbackDurationMs);
  }, [clearRevealTimer, reveal]);

  useEffect(() => clearRevealTimer, [clearRevealTimer]);

  useEffect(() => {
    clearRevealTimer();
    setRevealed(!showsChest);
    setAnimationMode("starting");
    setVideoPlaying(false);
  }, [clearRevealTimer, outcome, showsChest]);

  useEffect(() => {
    if (!showsChest) return;
    const canvas = canvasRef.current;
    const chestArt = chestArtRef.current;
    if (!canvas || !chestArt) return;

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      reveal();
      return;
    }

    if (!navigator.gpu) {
      setAnimationMode("video");
      armVideoSafetyTimer();
      return;
    }

    const stopped = { current: false };
    let cleanup: (() => void) | undefined;
    let usingVideo = false;
    const beginVideo = () => {
      if (stopped.current || usingVideo) return;
      usingVideo = true;
      setAnimationMode("video");
      armVideoSafetyTimer();
      cleanup?.();
    };
    const startupTimer = window.setTimeout(beginVideo, animationStartupTimeoutMs);

    void startChestAnimation({
      canvas,
      chestArt,
      stopped,
      onReady: () => {
        if (usingVideo) return;
        window.clearTimeout(startupTimer);
        chestArt.style.opacity = "0";
        setAnimationMode("webgpu");
      },
      onReveal: reveal,
    })
      .then((stop) => {
        if (stopped.current || usingVideo) {
          stop?.();
          return;
        }
        if (!stop) {
          beginVideo();
          return;
        }
        cleanup = stop;
      })
      .catch((error: unknown) => {
        console.error("Could not start the admission result chest", error);
        window.clearTimeout(startupTimer);
        beginVideo();
      });

    return () => {
      stopped.current = true;
      window.clearTimeout(startupTimer);
      cleanup?.();
    };
  }, [armVideoSafetyTimer, reveal, showsChest]);

  const handleVideoPlaying = () => {
    setVideoPlaying(true);
    armVideoSafetyTimer();
  };

  const handleVideoEnded = () => {
    clearRevealTimer();
    reveal();
  };

  return (
    <PortalScene
      tree="both"
      header={header}
      {...(onSignOut ? { onSignOut } : {})}
      logoGlow
      fill
    >
      <section
        className={`admission-result-reveal admission-result-reveal--${outcome} ${
          animationMode === "static" ? "admission-result-reveal--fallback" : ""
        }`}
        aria-label={`Admission result for ${teamName}`}
      >
        {showsChest &&
        (!revealed || animationMode === "webgpu" || animationMode === "video") ? (
          <>
            <canvas ref={canvasRef} aria-hidden className="admission-result-reveal__canvas" />
            {animationMode === "video" ? (
              <video
                autoPlay
                muted
                playsInline
                preload="auto"
                aria-hidden
                className="admission-result-reveal__video"
                src="/assets/result-chest-animation.webm"
                onEnded={handleVideoEnded}
                onError={beginStaticFallback}
                onPlaying={handleVideoPlaying}
              />
            ) : null}
            <img
              ref={chestArtRef}
              src="/assets/magic-lucky-chest.webp"
              alt=""
              draggable={false}
              className={`admission-result-reveal__chest ${
                animationMode === "webgpu" || (animationMode === "video" && videoPlaying)
                  ? "admission-result-reveal__chest--hidden"
                  : ""
              }`}
            />
            <p className="sr-only" role="status" aria-live="polite">
              Opening your Code2Create result.
            </p>
          </>
        ) : null}

        {revealed ? (
          <div className="admission-result-reveal__card-wrap">
            <div
              className={`admission-result-reveal__card admission-result-reveal__card--${
                showsChest ? "petals" : "quiet"
              }`}
              role="status"
            >
              {showsChest ? (
                <div aria-hidden className="admission-result-reveal__petal-frame">
                  {selectedCardPetals.map((petal, index) => (
                    <span
                      key={`${petal.left}-${petal.top}-${index}`}
                      className="admission-result-reveal__frame-petal"
                      style={{
                        left: petal.left,
                        top: petal.top,
                        rotate: `${petal.rotation}deg`,
                        animationDelay: `${petal.delay}s`,
                      }}
                    >
                      <Petal
                        size={petal.size}
                        state={index % 7 === 0 ? "current" : "done"}
                      />
                    </span>
                  ))}
                </div>
              ) : null}
              <div className="admission-result-reveal__content">
                <h1>{copy.heading}</h1>
                <p className="admission-result-reveal__message">{copy.message(teamName)}</p>
                <p className="admission-result-reveal__event">{eventName}</p>
                <PortalButton
                  type="button"
                  variant="solid"
                  className="relative z-10 mt-6"
                  onClick={onContinue}
                >
                  {copy.action}
                </PortalButton>
              </div>
            </div>
          </div>
        ) : null}
      </section>
    </PortalScene>
  );
}

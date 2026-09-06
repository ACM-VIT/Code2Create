import { useEffect, useRef, useState } from "react";

import { useReducedMotion } from "../dashboard/useReducedMotion";
import type { ChillScene } from "./chillScene";

type Phase = "off" | "on" | "leaving";

/**
 * Chill mode, over the whole portal: the room dims, coloured light drifts
 * across it, and the disco ball lowers in on its chain and turns. The layer
 * is inert to the pointer so the portal underneath keeps working. When the
 * desk turns it off the ball is hoisted out before the layer unmounts.
 */
export function ChillMode({ active }: { active: boolean }) {
  const [phase, setPhase] = useState<Phase>(active ? "on" : "off");
  if (active && phase !== "on") setPhase("on");
  if (!active && phase === "on") setPhase("leaving");
  const reducedMotion = useReducedMotion();
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const scene = useRef<ChillScene | null>(null);
  const mounted = phase !== "off";

  // Three.js only arrives when the desk asks for the ball.
  useEffect(() => {
    if (!mounted) return;
    const host = canvas.current;
    if (!host) return;
    let cancelled = false;
    void import("./chillScene").then(({ createChillScene }) => {
      if (cancelled) return;
      try {
        const created = createChillScene(host, { reducedMotion });
        scene.current = created;
        void created.enter();
      } catch {
        // No WebGL: the dim and the light pools carry the mood on their own.
      }
    });
    return () => {
      cancelled = true;
      scene.current?.dispose();
      scene.current = null;
    };
  }, [mounted, reducedMotion]);

  useEffect(() => {
    if (phase === "on") void scene.current?.enter();
  }, [phase]);

  useEffect(() => {
    if (phase !== "leaving") return;
    let cancelled = false;
    const gone = scene.current ? scene.current.leave() : Promise.resolve();
    void gone.then(() => {
      if (!cancelled) setPhase("off");
    });
    return () => {
      cancelled = true;
    };
  }, [phase]);

  if (!mounted) return null;
  return (
    <div aria-hidden className={`chill ${phase === "leaving" ? "chill-leaving" : ""}`}>
      <div className="chill-dim" />
      <div className="chill-pool chill-pool-a" />
      <div className="chill-pool chill-pool-b" />
      <div className="chill-pool chill-pool-c" />
      <canvas ref={canvas} className="absolute inset-0 size-full" />
    </div>
  );
}

import gsap from "gsap";
import { useEffect, useRef } from "react";
import { Plant, createBloomTimeline } from "../timeline/botanical.js";
import "./loader.css";

/**
 * The portal's loading indicator: the landing page's timeline bonsai, blooming
 * on a clock instead of a scroll. The pot stays planted while the blossoms
 * grow, hold, dissolve and grow again for as long as the wait lasts.
 *
 * 'scene' sits on the PortalScene night sky; 'shell' is the smaller one for
 * the panelled portal surface, with its muted status line.
 */
export function TreeLoader({
  label = "Loading",
  variant = "scene",
}: {
  label?: string;
  variant?: "scene" | "shell";
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  /* The wave dots below are the label's ellipsis; strip any the caller wrote
     so old "Loading…" strings don't end up double-dotted. */
  const labelBase = label.replace(/[.…\s]+$/u, "");

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const context = gsap.context(() => {
      const shell = stage.querySelector<HTMLElement>(".plant-shell");
      if (!shell) return;
      const growth = createBloomTimeline(shell, { moments: false });

      /* The OS setting silences CSS animation globally (index.css), but this
         timeline is JS-driven — hold it at full bloom instead of playing. */
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        growth.progress(1).pause();
        return;
      }

      /* The growth was authored across ~8s of scrubbed scroll; a loader wants
         the full bloom sooner than that. */
      growth.timeScale(1.45);
      const loop = gsap.timeline({ repeat: -1, repeatDelay: 0.45 });
      loop.add(growth);
      /* Only the vectors and their glow fade for the restart — the pot plate
         stays put, so the loop reads as re-flowering, not a hard reset. */
      loop.to(
        stage.querySelectorAll(".plant-svg, .plant-aura"),
        { autoAlpha: 0, duration: 0.65, ease: "power1.inOut" },
        "+=0.9",
      );
    }, stage);
    return () => context.revert();
  }, []);

  return (
    <div role="status" className={`tree-loader tree-loader-${variant}`}>
      <div ref={stageRef} aria-hidden="true" className="tree-loader-stage">
        <Plant />
      </div>
      <p className={"tree-loader-label"}>
        {labelBase}
        <span aria-hidden="true" className="tree-loader-dots">
          <span>.</span>
          <span>.</span>
          <span>.</span>
        </span>
      </p>
    </div>
  );
}

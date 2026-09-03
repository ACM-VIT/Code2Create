/*
 * Every chapter lives inside one pinned stage, so navigation can't jump to an
 * anchor — it has to land the scroll at the point in the journey where that
 * chapter is on screen. About and Sponsors use twice the physical scroll
 * distance, so the stops are derived from master-timeline positions through
 * the same weighted mapping as the ScrollTrigger.
 */
import { journeyScrollProgress } from "../journey/timing.js";

export const JOURNEY_LEAP_EVENT = "journey:leap";

export interface JourneyLeapDetail {
  progress: number;
}

declare global {
  interface WindowEventMap {
    "journey:leap": CustomEvent<JourneyLeapDetail>;
  }
}

export const JOURNEY_STOPS = {
  about: journeyScrollProgress(35),
  stats: journeyScrollProgress(90),
  sponsors: journeyScrollProgress(109),
  timeline: journeyScrollProgress(158),
  faqs: journeyScrollProgress(283),
} as const;

/** Jump directly to a fraction of the journey (0 = hero, 1 = its end). */
export function leapTo(at: number) {
  const journey = document.querySelector<HTMLElement>(".journey");
  if (!journey) return;

  const progress = Math.max(0, Math.min(1, at));
  const travel = journey.offsetHeight - window.innerHeight;
  const root = document.documentElement;
  const previousScrollBehavior = root.style.scrollBehavior;

  root.style.scrollBehavior = "auto";
  window.scrollTo({ top: journey.offsetTop + travel * progress, behavior: "auto" });
  root.style.scrollBehavior = previousScrollBehavior;

  /* ScrollTrigger's numeric scrub normally eases toward a new scroll
     position. A nav jump asks the journey to resolve that state immediately. */
  window.dispatchEvent(
    new CustomEvent<JourneyLeapDetail>(JOURNEY_LEAP_EVENT, { detail: { progress } }),
  );
}

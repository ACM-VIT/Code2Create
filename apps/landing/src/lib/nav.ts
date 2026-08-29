/*
 * Every chapter lives inside one pinned stage, so in-page nav can't just jump
 * to an anchor — it has to scroll to the point in the journey where that
 * chapter is on screen. The fractions below are positions along the master
 * timeline (244s total): about ≈35s, stats ≈90s, timeline ≈112s, FAQs ≈237s —
 * the FAQs one deliberately past the act's 234s fall cue.
 */
export const journeyChapters = [
  { label: 'About', at: 0.14 },
  { label: 'Stats', at: 0.37 },
  { label: 'Timeline', at: 0.46 },
  { label: 'FAQs', at: 0.97 },
] as const;

/*
 * The warp: the stage blurs out, the scroll lands INSTANTLY at the target,
 * and the stage blurs back in — no riding the whole journey there. The
 * scrub's own catch-up plays behind the veil.
 */
let warpTimer: ReturnType<typeof setTimeout> | undefined;

export const warpTo = (top: number) => {
  const rootEl = document.documentElement;
  clearTimeout(warpTimer);
  rootEl.classList.add('nav-warp');
  warpTimer = setTimeout(() => {
    window.scrollTo({ top, behavior: 'auto' });
    warpTimer = setTimeout(() => rootEl.classList.remove('nav-warp'), 620);
  }, 240);
};

export const warpToJourney = (at: number) => {
  const journey = document.querySelector<HTMLElement>('.journey');
  if (!journey) return;

  /* A deliberate leap: the journey walls its scroll while the FAQ act is
     mid-play, and those walls must not fight a nav jump. */
  window.dispatchEvent(new Event('journey:leap'));

  const travel = journey.offsetHeight - window.innerHeight;
  warpTo(journey.offsetTop + travel * at);
};

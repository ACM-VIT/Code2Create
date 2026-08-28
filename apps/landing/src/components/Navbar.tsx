import { useEffect, useState, type MouseEvent } from 'react';

/*
 * Every chapter lives inside one pinned stage, so the nav can't just jump to
 * an anchor — it has to scroll to the point in the journey where that chapter
 * is on screen. The fractions below are positions along the master timeline
 * (249s total): about ≈35s, stats ≈90s, timeline ≈112s, FAQs ≈237s.
 */
const links = [
  { label: 'About', at: 0.14 },
  { label: 'FAQs', at: 0.95 },
  { label: 'Timeline', at: 0.45 },
  { label: 'Stats', at: 0.36 },
];

/*
 * The warp: the stage blurs out, the scroll lands INSTANTLY at the target,
 * and the stage blurs back in — no riding the whole journey there. The
 * scrub's own catch-up plays behind the veil.
 */
let warpTimer: ReturnType<typeof setTimeout> | undefined;
const warpTo = (top: number) => {
  const rootEl = document.documentElement;
  clearTimeout(warpTimer);
  rootEl.classList.add('nav-warp');
  warpTimer = setTimeout(() => {
    window.scrollTo({ top, behavior: 'auto' });
    warpTimer = setTimeout(() => rootEl.classList.remove('nav-warp'), 620);
  }, 240);
};

export default function Navbar() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const close = () => setOpen(false);
    window.addEventListener('resize', close);
    return () => window.removeEventListener('resize', close);
  }, []);

  const goTo = (event: MouseEvent<HTMLAnchorElement>, at: number) => {
    event.preventDefault();
    setOpen(false);

    const journey = document.querySelector<HTMLElement>('.journey');
    if (!journey) return;

    /* A deliberate leap: the journey walls its scroll while the FAQ act is
       mid-play, and those walls must not fight a nav jump. */
    window.dispatchEvent(new Event('journey:leap'));

    const travel = journey.offsetHeight - window.innerHeight;
    warpTo(journey.offsetTop + travel * at);
  };

  return (
    <header className="navbar">
      <nav className="navbar__inner" aria-label="Primary">
        <a
          className="navbar__brand"
          href="#top"
          onClick={(event) => {
            event.preventDefault();
            window.dispatchEvent(new Event('journey:leap'));
            warpTo(0);
          }}
        >
          <img src="/assets/svg/logo.svg" alt="" width="34" height="38" />
          <span>Code2Create</span>
        </a>

        <button
          className="navbar__toggle"
          type="button"
          aria-expanded={open}
          aria-label={open ? 'Close menu' : 'Open menu'}
          onClick={() => setOpen((value) => !value)}
        >
          <span />
        </button>

        <div className="navbar__links" data-open={open}>
          {links.map((link) => (
            <a key={link.label} href="#top" onClick={(event) => goTo(event, link.at)}>
              {link.label}
            </a>
          ))}
        </div>
      </nav>
    </header>
  );
}

import { useEffect, useState, type MouseEvent } from "react";

import { JOURNEY_STOPS, leapTo } from "../lib/journeyLeap.js";

const links = [
  { label: "About", at: JOURNEY_STOPS.about },
  { label: "Stats", at: JOURNEY_STOPS.stats },
  { label: "Sponsors", at: JOURNEY_STOPS.sponsors },
  { label: "Timeline", at: JOURNEY_STOPS.timeline },
  { label: "FAQs", at: JOURNEY_STOPS.faqs },
];

export default function Navbar() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const close = () => setOpen(false);
    window.addEventListener("resize", close);
    return () => window.removeEventListener("resize", close);
  }, []);

  const goTo = (event: MouseEvent<HTMLAnchorElement>, at: number) => {
    event.preventDefault();
    setOpen(false);
    leapTo(at);
  };

  return (
    <header className="navbar">
      <nav className="navbar__inner" aria-label="Primary">
        <a
          className="navbar__brand"
          href="#top"
          onClick={(event) => {
            event.preventDefault();
            leapTo(0);
          }}
        >
          <img src="/assets/svg/logo.svg" alt="" width="34" height="38" />
          <span>Code2Create</span>
        </a>

        <button
          className="navbar__toggle"
          type="button"
          aria-expanded={open}
          aria-label={open ? "Close menu" : "Open menu"}
          onClick={() => setOpen((value) => !value)}
        >
          <span />
        </button>

        <div className="navbar__links" data-open={open ? "true" : "false"}>
          <a href="/photos">Photos</a>
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

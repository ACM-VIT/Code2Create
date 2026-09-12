import type { MouseEvent } from "react";

import { JOURNEY_STOPS, leapTo } from "../lib/journeyLeap.js";
import "./footer.css";

/* Journey links stay on the page; external links open in a new tab. */
const groups: {
  title: string;
  items: { label: string; at?: number; href?: string }[];
}[] = [
  {
    title: "Explore",
    items: [
      { label: "About", at: JOURNEY_STOPS.about },
      { label: "Stats", at: JOURNEY_STOPS.stats },
      { label: "Timeline", at: JOURNEY_STOPS.timeline },
      { label: "FAQs", at: JOURNEY_STOPS.faqs },
    ],
  },
  {
    title: "Our Projects",
    items: [
      { label: "Conclave", href: "https://conclave.acmvit.in" },
      { label: "UniPool", href: "https://unipool.in" },
      { label: "ExamCooker", href: "https://examcooker.acmvit.in" },
      { label: "TAGRED", href: "https://github.com/ACM-VIT/TAGRED" },
    ],
  },
  {
    title: "ACM-VIT",
    items: [
      { label: "Website", href: "https://acmvit.in" },
      { label: "GitHub", href: "https://github.com/ACM-VIT" },
    ],
  },
  {
    title: "Policies",
    items: [
      { label: "Participant policy", href: "/policy" },
      { label: "Privacy notice", href: "/privacy" },
    ],
  },
];

const socials = [
  {
    label: "Facebook",
    icon: "/assets/svg/facebook.svg",
    href: "https://www.facebook.com/acmvitvellore",
  },
  { label: "Twitter", icon: "/assets/svg/twitter.svg", href: "https://x.com/acm_vit" },
  {
    label: "Instagram",
    icon: "/assets/svg/instagram.svg",
    href: "https://www.instagram.com/acmvit",
  },
  {
    label: "Medium",
    icon: "/assets/img/medium.png",
    href: "https://medium.com/acmvit",
    mask: true,
  },
  {
    label: "LinkedIn",
    icon: "/assets/svg/linkedin.svg",
    href: "https://www.linkedin.com/company/acmvit",
  },
  { label: "YouTube", icon: "/assets/img/youtube.png", href: "https://www.youtube.com/@acm_vit" },
];

export default function Footer() {
  const jump = (event: MouseEvent<HTMLAnchorElement>, at: number) => {
    event.preventDefault();
    leapTo(at);
  };

  return (
    <footer className="footer" id="register">
      <div className="shell footer__inner">
        <div className="footer__brand">
          <p className="footer__brand-name">Code2Create</p>
        </div>

        <nav className="footer__nav" aria-label="Footer">
          {groups.map((group) => (
            <div className="footer__group" key={group.title}>
              <p className="footer__group-title">{group.title}</p>
              <ul>
                {group.items.map((item) => {
                  const chapterAt = item.at;
                  const opensNewTab = item.href?.startsWith("http") ?? false;
                  return (
                    <li key={item.label}>
                      {chapterAt === undefined ? (
                        <a
                          href={item.href}
                          target={opensNewTab ? "_blank" : undefined}
                          rel={opensNewTab ? "noreferrer" : undefined}
                        >
                          {item.label}
                        </a>
                      ) : (
                        <a href="#top" onClick={(event) => jump(event, chapterAt)}>
                          {item.label}
                        </a>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>
      </div>

      <ul className="footer__socials">
        {socials.map((social) => (
          <li key={social.label}>
            <a href={social.href} target="_blank" rel="noreferrer" aria-label={social.label}>
              {social.mask === true ? (
                <span
                  className="footer__mask-icon"
                  style={{
                    maskImage: `url(${social.icon})`,
                    WebkitMaskImage: `url(${social.icon})`,
                  }}
                />
              ) : (
                <img src={social.icon} alt="" width="31" height="31" />
              )}
            </a>
          </li>
        ))}
      </ul>

      <p className="footer__love">
        <img src="/assets/svg/heart.svg" alt="" width="36" height="35" />
        crafted with love by ACM-VIT
      </p>

      <img className="footer__wordmark" src="/assets/svg/wordmark-lg.svg" alt="Code2Create" />
      <div className="footer__play" aria-hidden="true" />
    </footer>
  );
}

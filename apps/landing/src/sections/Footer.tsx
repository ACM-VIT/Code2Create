import { type MouseEvent } from 'react';

import { warpToJourney } from '../lib/nav.js';
import './footer.css';

interface FooterLink {
  label: string
  href: string
  at?: number
}

/* Link groups from Figma node 1681:1322, minus the Guests and Timeline
   columns, which this edition does not carry. Destinations follow the
   chapter site where a product has no public URL of its own. */
const groups: { title: string; items: FooterLink[] }[] = [
  {
    title: 'About',
    items: [
      { label: 'c2c', href: '#about', at: 0.14 },
      { label: 'acm', href: 'https://acmvit.in' },
    ],
  },
  {
    title: 'Our Products',
    items: [
      { label: 'ACMONE', href: 'https://acmvit.in#projects' },
      { label: 'CLI-RPG', href: 'https://cli-rpg.acmvit.in' },
      { label: 'EXAMCOOKER', href: 'https://examcooker.acmvit.in' },
      { label: 'CLITOP', href: 'https://clitop.acmvit.in' },
      { label: 'LOCALHOST', href: 'https://localhost.acmvit.in' },
      { label: 'OS', href: 'https://os.acmvit.in' },
      { label: 'UNIPOOL', href: 'https://unipool.acmvit.in' },
    ],
  },
  {
    title: 'Sponsors',
    items: [
      { label: 'about w', href: 'https://acmvit.in#acm-w' },
      { label: 'events', href: 'https://acmvit.in#events' },
    ],
  },
];

const socials = [
  { label: 'Facebook', icon: '/assets/svg/facebook.svg', href: 'https://www.facebook.com/acmvitvellore' },
  { label: 'Twitter', icon: '/assets/svg/twitter.svg', href: 'https://x.com/acm_vit' },
  { label: 'Instagram', icon: '/assets/svg/instagram.svg', href: 'https://www.instagram.com/acmvit' },
  { label: 'Medium', icon: '/assets/img/medium.png', href: 'https://medium.com/acmvit', mask: true },
  { label: 'LinkedIn', icon: '/assets/svg/linkedin.svg', href: 'https://www.linkedin.com/company/acmvit' },
  { label: 'YouTube', icon: '/assets/img/youtube.png', href: 'https://www.youtube.com/@acm_vit' },
];

export default function Footer() {
  const goToChapter = (event: MouseEvent<HTMLAnchorElement>, at: number) => {
    event.preventDefault();
    warpToJourney(at);
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
                  return (
                    <li key={item.label}>
                      {chapterAt === undefined ? (
                        <a href={item.href} target="_blank" rel="noreferrer">
                          {item.label}
                        </a>
                      ) : (
                        <a href={item.href} onClick={(event) => goToChapter(event, chapterAt)}>
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
              {social.mask ? (
                <span
                  className="footer__mask-icon"
                  style={{ maskImage: `url(${social.icon})`, WebkitMaskImage: `url(${social.icon})` }}
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
    </footer>
  );
}

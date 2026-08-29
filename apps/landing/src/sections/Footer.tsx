import './footer.css';

/* Link groups from Figma node 1681:1322, minus the Guests and Timeline
   columns, which this edition does not carry. */
const groups = [
  { title: 'About', items: ['c2c', 'acm'] },
  {
    title: 'Our Products',
    items: ['ACMONE', 'CLI-RPG', 'EXAMCOOKER', 'CLITOP', 'LOCALHOST', 'OS', 'UNIPOOL'],
  },
  { title: 'Sponsors', items: ['about w', 'events'] },
];

const socials = [
  { label: 'Facebook', icon: '/assets/svg/facebook.svg', href: 'https://facebook.com/acmvit' },
  { label: 'Twitter', icon: '/assets/svg/twitter.svg', href: 'https://twitter.com/acmvit' },
  { label: 'Instagram', icon: '/assets/svg/instagram.svg', href: 'https://instagram.com/acmvit' },
  { label: 'Medium', icon: '/assets/img/medium.png', href: 'https://medium.com/acmvit', mask: true },
  { label: 'LinkedIn', icon: '/assets/svg/linkedin.svg', href: 'https://linkedin.com/company/acmvit' },
  { label: 'YouTube', icon: '/assets/img/youtube.png', href: 'https://youtube.com/@acmvit' },
];

export default function Footer() {
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
                {group.items.map((item) => (
                  <li key={item}>
                    <a href="#top">{item}</a>
                  </li>
                ))}
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

/**
 * Line icons, drawn on a 24-unit grid at 1.5 stroke so they sit optically
 * level with 13px labels. Inline rather than a dependency: the shell needs
 * fourteen glyphs, and a package would ship hundreds.
 */
export type IconName =
  | 'home'
  | 'lifebuoy'
  | 'inbox'
  | 'scan'
  | 'map'
  | 'music'
  | 'gavel'
  | 'chart'
  | 'notes'
  | 'code'
  | 'sliders'
  | 'users'
  | 'flask'
  | 'shield'
  | 'alert'
  | 'clock'
  | 'seat'
  | 'pause'
  | 'arrow'
  | 'github'
  | 'figma'

const paths: Record<IconName, string> = {
  home: 'M3 10.5 12 3l9 7.5M5.5 9.5V20a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V9.5',
  lifebuoy: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM5.6 5.6l3.2 3.2M15.2 15.2l3.2 3.2M18.4 5.6l-3.2 3.2M8.8 15.2l-3.2 3.2',
  inbox: 'M3 13h5l1.5 3h5L16 13h5M4.5 6h15l1.5 7v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-5l1.5-7Z',
  scan: 'M3 8V5a1 1 0 0 1 1-1h3M17 4h3a1 1 0 0 1 1 1v3M21 16v3a1 1 0 0 1-1 1h-3M7 20H4a1 1 0 0 1-1-1v-3M3 12h18',
  map: 'M9 4 3 6.5v13L9 17l6 2.5 6-2.5v-13L15 6.5 9 4Zm0 0v13m6-10.5v13',
  music: 'M9 18V6l10-2v12M9 18a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Zm10-2a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Z',
  gavel: 'm14 6 4 4M8.5 11.5 4 16a2.1 2.1 0 0 0 3 3l4.5-4.5M10 4l10 10-2.5 2.5L7.5 6.5 10 4ZM4 21h9',
  chart: 'M5 20V10M12 20V4M19 20v-7',
  notes: 'M5 4.5A1.5 1.5 0 0 1 6.5 3h7L19 8.5v11a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 19.5v-15ZM13 3v6h6M8.5 13h7M8.5 17h4',
  code: 'm9 7-5 5 5 5M15 7l5 5-5 5',
  sliders: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 4v6M7 14v6',
  users: 'M15.5 20v-1.5a4 4 0 0 0-4-4h-4a4 4 0 0 0-4 4V20M9.5 10.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM20.5 20v-1.5a4 4 0 0 0-3-3.87M16 3.63a4 4 0 0 1 0 7.75',
  flask: 'M9.5 3v6.2L4.6 17.4A2 2 0 0 0 6.3 20.5h11.4a2 2 0 0 0 1.7-3.1L14.5 9.2V3M8 3h8M7.4 14h9.2',
  shield: 'M12 21s7-3.2 7-9V6l-7-3-7 3v6c0 5.8 7 9 7 9Z',
  alert: 'M12 8.5v5M12 17h.01M10.3 3.9 2.6 17.2A2 2 0 0 0 4.3 20.2h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7v5l3 2',
  seat: 'M6 20v-3M18 20v-3M5 17h14M6.5 17V8a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v9M9.5 6V4.5h5V6',
  pause: 'M10 5v14M14 5v14',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  github: 'M15 21v-3.4a3.7 3.7 0 0 0-1-2.6c2.9-.3 6-1.5 6-6.1 0-1.4-.4-2.5-1.1-3.3.2-.4.5-1.6-.1-3.3 0 0-1-.3-3.3 1.2a11.4 11.4 0 0 0-6 0C7.2 2 6.2 2.3 6.2 2.3c-.6 1.7-.3 2.9-.1 3.3C5.4 6.4 5 7.5 5 8.9c0 4.6 3.1 5.8 6 6.1a3.7 3.7 0 0 0-1 2.6V21M10 18.3c-3.4 1.5-4.3-1.7-5.8-1.7',
  figma: 'M12 3H9a3 3 0 0 0 0 6h3ZM12 3h3a3 3 0 0 1 0 6h-3ZM12 9H9a3 3 0 0 0 0 6h3ZM15 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM9 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
}

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg
      aria-hidden="true"
      className="icon"
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.5}
      viewBox="0 0 24 24"
      width={size}
    >
      <path d={paths[name]} />
    </svg>
  )
}

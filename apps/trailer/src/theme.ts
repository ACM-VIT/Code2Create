export const COLORS = {
  paper: '#F4EAE0',
  ink: '#241019',
  night: '#0C0004',
  plum: '#6D2B42',
  plumShadow: '#2A1420',
  blossomLight: '#F1CEDF',
  blossomMid: '#E3A9BF',
  rose: '#D884A2',
  roseDeep: '#B44F76',
  white: '#FAFBFB',
  warmWhite: '#FFF6F1',
  wash: '#FBEDF2',
} as const

// Animation timings are absolute frames at 30 fps.
export const T = {
  kickerIn: 30,
  kickerOut: 116,
  shot2: 124,
  lineAIn: 168,
  lineAOut: 272,
  shot3: 282,
  lineBIn: 302,
  lineBOut: 402,
  diveStart: 408,
  washStart: 448,
  washPeak: 458,
  washEnd: 478,
  actB: 458,
  whoosh: 436,
  fadeOutStart: 706,
  total: 720,
} as const

export const CLAMP = {
  extrapolateLeft: 'clamp',
  extrapolateRight: 'clamp',
} as const

export const R = {
  flight: 240,
  snap: 330,
  lockup: 342,
  word: 358,
  night: 400,
  tagline: 448,
  url: 500,
  fade: 586,
  total: 600,
} as const

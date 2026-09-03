export const tileKeys = [
  'status',
  'team',
  'music',
  'integrations',
  'updates',
  'queue',
  'help',
] as const

export type TileKey = (typeof tileKeys)[number]

export type GridTemplate = {
  columns: string
  rows: string
  areas: readonly string[]
}

type Breakpoint = 'base' | 'md' | 'lg'

const resting: Record<Breakpoint, GridTemplate> = {
  base: {
    columns: 'repeat(2, minmax(0, 1fr))',
    rows: 'repeat(5, minmax(118px, 1fr))',
    areas: ['status status', 'team music', 'integrations integrations', 'queue queue', 'help updates'],
  },
  md: {
    columns: 'repeat(2, minmax(0, 1fr))',
    rows: '1.35fr 1fr 1fr 1fr 1fr',
    areas: ['status status', 'team music', 'integrations queue', 'updates queue', 'updates help'],
  },
  lg: {
    columns: '322fr 365fr 395fr',
    rows: '293fr 234fr 70fr 177fr',
    areas: [
      'status status team',
      'music integrations queue',
      'music updates queue',
      'help updates queue',
    ],
  },
}

const focused: Record<Breakpoint, GridTemplate> = {
  base: {
    columns: 'repeat(2, minmax(0, 1fr))',
    rows: 'repeat(2, minmax(190px, 1.4fr)) repeat(3, minmax(108px, 1fr))',
    areas: ['F F', 'F F', 'a b', 'c d', 'e g'],
  },
  md: {
    columns: 'repeat(2, minmax(0, 1fr))',
    rows: 'repeat(2, minmax(200px, 1.5fr)) repeat(3, minmax(0, 1fr))',
    areas: ['F F', 'F F', 'a b', 'c d', 'e g'],
  },
  lg: {
    columns: '322fr 365fr 395fr',
    rows: '293fr 234fr 120fr 127fr',
    areas: ['F F a', 'F F b', 'c c b', 'd e g'],
  },
}

const slotOrder = ['a', 'b', 'c', 'd', 'e', 'g'] as const

function fillTemplate(template: GridTemplate, focus: TileKey): GridTemplate {
  const others = tileKeys.filter((key) => key !== focus)
  const bySlot = new Map<string, TileKey>([['F', focus]])
  slotOrder.forEach((slot, index) => {
    const tile = others[index]
    if (tile) bySlot.set(slot, tile)
  })
  return {
    ...template,
    areas: template.areas.map((row) =>
      row
        .split(' ')
        .map((cell) => bySlot.get(cell) ?? cell)
        .join(' '),
    ),
  }
}

export function gridTemplates(focus: TileKey | null): Record<Breakpoint, GridTemplate> {
  if (focus === null) return resting
  return {
    base: fillTemplate(focused.base, focus),
    md: fillTemplate(focused.md, focus),
    lg: fillTemplate(focused.lg, focus),
  }
}

export function areasValue(template: GridTemplate) {
  return template.areas.map((row) => `"${row}"`).join(' ')
}

export const tileAreaClass: Record<TileKey, string> = {
  status: '[grid-area:status]',
  team: '[grid-area:team]',
  music: '[grid-area:music]',
  integrations: '[grid-area:integrations]',
  updates: '[grid-area:updates]',
  queue: '[grid-area:queue]',
  help: '[grid-area:help]',
}

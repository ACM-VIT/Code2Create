import Svg, { Path } from 'react-native-svg'

/**
 * Duty glyphs, drawn on a 24-unit grid at 1.7 stroke and rendered at 28px.
 * Larger and heavier than the dashboard's 16px icons: this app is read at
 * arm's length in a hall, not at a desk.
 */
export type DutyIconName = 'judging' | 'door' | 'hall' | 'help' | 'clock' | 'queue' | 'badge' | 'chart'

const paths: Record<DutyIconName, string> = {
  judging:
    'M5 4.5A1.5 1.5 0 0 1 6.5 3h7L19 8.5v11a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 19.5v-15ZM13 3v6h6M8.5 13h7M8.5 17h4',
  door: 'M3 8V5a1 1 0 0 1 1-1h3M17 4h3a1 1 0 0 1 1 1v3M21 16v3a1 1 0 0 1-1 1h-3M7 20H4a1 1 0 0 1-1-1v-3M3 12h18',
  hall: 'M9 4 3 6.5v13L9 17l6 2.5 6-2.5v-13L15 6.5 9 4Zm0 0v13m6-10.5v13',
  help: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM5.6 5.6l3.2 3.2M15.2 15.2l3.2 3.2M18.4 5.6l-3.2 3.2M8.8 15.2l-3.2 3.2',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7v5l3 2',
  queue: 'M4 12a8 8 0 0 1 13.7-5.6M20 12a8 8 0 0 1-13.7 5.6M17 3v4h-4M7 21v-4h4',
  badge: 'M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1ZM12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM8 17c1-2 2.6-3 4-3s3 1 4 3',
  chart: 'M5 20V10M12 20V4M19 20v-7',
}

export function DutyIcon({
  name,
  color,
  size = 28,
}: {
  name: DutyIconName
  color: string
  size?: number
}) {
  return (
    <Svg fill="none" height={size} viewBox="0 0 24 24" width={size}>
      <Path
        d={paths[name]}
        stroke={color}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.7}
      />
    </Svg>
  )
}

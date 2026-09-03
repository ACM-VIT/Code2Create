import Svg, { Path } from "react-native-svg";

export type DutyIconName =
  | "judging"
  | "door"
  | "hall"
  | "help"
  | "pulse"
  | "incident"
  | "clock"
  | "queue"
  | "badge"
  | "chart"
  | "home"
  | "question"
  | "person";

const paths: Record<DutyIconName, string> = {
  judging:
    "M5 4.5A1.5 1.5 0 0 1 6.5 3h7L19 8.5v11a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 19.5v-15ZM13 3v6h6M8.5 13h7M8.5 17h4",
  door: "M3 8V5a1 1 0 0 1 1-1h3M17 4h3a1 1 0 0 1 1 1v3M21 16v3a1 1 0 0 1-1 1h-3M7 20H4a1 1 0 0 1-1-1v-3M3 12h18",
  hall: "M9 4 3 6.5v13L9 17l6 2.5 6-2.5v-13L15 6.5 9 4Zm0 0v13m6-10.5v13",
  help: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM5.6 5.6l3.2 3.2M15.2 15.2l3.2 3.2M18.4 5.6l-3.2 3.2M8.8 15.2l-3.2 3.2",
  pulse: "M2.5 12.5H7l2.5-6.5 4.5 12 2.5-5.5h5",
  incident: "M12 3.8 2.6 19.6a.5.5 0 0 0 .4.7h18a.5.5 0 0 0 .4-.7L12 3.8ZM12 10v4.5M12 17.4v.2",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7v5l3 2",
  queue: "M4 12a8 8 0 0 1 13.7-5.6M20 12a8 8 0 0 1-13.7 5.6M17 3v4h-4M7 21v-4h4",
  badge:
    "M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1ZM12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM8 17c1-2 2.6-3 4-3s3 1 4 3",
  chart: "M5 20V10M12 20V4M19 20v-7",
  home: "M4 4h6v6H4V4Zm10 0h6v6h-6V4ZM4 14h6v6H4v-6Zm10 0h6v6h-6v-6Z",
  question: "M8.6 8.7a3.4 3.4 0 1 1 4.3 3.3c-.6.2-1 .8-1 1.4v1.1M11.9 19v.2",
  person: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4.5 20.5c1.4-3.4 4.2-5.2 7.5-5.2s6.1 1.8 7.5 5.2",
};

export function DutyIcon({
  name,
  color,
  size = 28,
}: {
  name: DutyIconName;
  color: string;
  size?: number;
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
  );
}

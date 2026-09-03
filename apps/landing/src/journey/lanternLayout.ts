export const LANTERNS = [
  {
    art: "/assets/svg/lantern-4.svg",
    value: "2000+",
    label: "Participants",
    x: 54,
    y: 13,
    size: 8.4,
    from: -46,
    drop: 16,
    phone: { x: 17, y: 46, size: 13 },
  },
  {
    art: "/assets/svg/lantern-1.svg",
    value: "7th",
    label: "Edition",
    x: 17,
    y: 22,
    size: 11.6,
    from: -34,
    drop: 22,
    phone: { x: 16, y: 11, size: 19 },
  },
  {
    art: "/assets/svg/lantern-3.svg",
    value: "25+",
    label: "Past Sponsors",
    x: 76,
    y: 30,
    size: 8.6,
    from: -58,
    drop: 12,
    phone: { x: 69, y: 65.5, size: 13 },
  },
  {
    art: "/assets/svg/lantern-2.svg",
    value: "250+",
    label: "Projects",
    x: 36,
    y: 40,
    size: 8.4,
    from: -42,
    drop: 18,
    phone: { x: 66.5, y: 31, size: 13 },
  },
];

export const lanternAt = (index: number, phone: boolean) =>
  phone && LANTERNS[index].phone
    ? { ...LANTERNS[index], ...LANTERNS[index].phone }
    : LANTERNS[index];

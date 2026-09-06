import type { ShowcaseProject } from "../screens/ShowcaseScreen";

/**
 * Sample projects for the showcase while the gallery has no backend feed.
 * The live route renders these too until submissions are wired through.
 */
export const showcaseSamples: readonly ShowcaseProject[] = [
  {
    id: "lanternfall",
    name: "Lanternfall",
    team: "Paper Cranes",
    track: "Open",
    tagline: "A city-scale lost-and-found that runs on paper lanterns and QR stickers.",
    blurb:
      "Anyone who finds a lost thing scans the sticker and a lantern lights on the owner's map. No accounts, no app to install: the sticker is the identity, and a lantern fades after seven days of quiet. Built on a tiny Convex backend and a lot of walking around campus.",
    tags: ["Convex", "React", "Maps"],
    members: [
      { name: "Aarav", seed: "aarav" },
      { name: "Meera", seed: "meera" },
      { name: "Riya", seed: "riya" },
      { name: "Dev", seed: "dev" },
    ],
    links: { github: "https://github.com", demo: "https://example.com" },
    featured: true,
  },
  {
    id: "quietroom",
    name: "Quiet Room",
    team: "Low Tide",
    track: "Wellbeing",
    tagline: "Study rooms that book themselves from your calendar's dead space.",
    blurb:
      "Reads the gaps in a class timetable, finds a room that is actually free, and holds it. Cancels itself if nobody taps in within ten minutes.",
    tags: ["Next.js", "Google Calendar", "Postgres"],
    members: [
      { name: "Sana", seed: "sana" },
      { name: "Kabir", seed: "kabir" },
    ],
    links: { github: "https://github.com" },
  },
  {
    id: "sourdough",
    name: "Sourdough",
    team: "Crumb",
    track: "Open",
    tagline: "Version control for recipes, with forks that actually mean something.",
    blurb:
      "Every recipe is a tree of edits. Fork one, swap the flour, and the diff shows what changed at each step. Bakers upvote branches, and the best one bubbles up as the trunk.",
    tags: ["SvelteKit", "SQLite"],
    members: [
      { name: "Ishita", seed: "ishita" },
      { name: "Rohan", seed: "rohan" },
      { name: "Tara", seed: "tara" },
    ],
    links: { demo: "https://example.com" },
  },
  {
    id: "ferry",
    name: "Ferry",
    track: "Infra",
    team: "Harbour",
    tagline: "Move a Docker Compose stack between laptops without breaking the volumes.",
    blurb:
      "Snapshots the volumes, ships them over the local network, and rewrites the compose file for the other machine's paths. Pairing over QR, transfer over mDNS.",
    tags: ["Go", "Docker", "mDNS"],
    members: [
      { name: "Vikram", seed: "vikram" },
      { name: "Anaya", seed: "anaya" },
    ],
    links: { github: "https://github.com" },
  },
  {
    id: "hummingbird",
    name: "Hummingbird",
    team: "Small Hours",
    track: "AI",
    tagline: "Lecture recordings that answer questions in the lecturer's own words.",
    blurb:
      "Transcribes a recording, then answers only with quoted spans from it. If the answer is not in the lecture, it says so, with the nearest moment to skip to.",
    tags: ["Whisper", "Claude", "Vite"],
    members: [
      { name: "Nikhil", seed: "nikhil" },
      { name: "Priya", seed: "priya" },
      { name: "Arjun", seed: "arjun" },
    ],
    links: { github: "https://github.com", demo: "https://example.com" },
  },
  {
    id: "tidepool",
    name: "Tidepool",
    team: "Salt",
    track: "Wellbeing",
    tagline: "A shared mood board for a hostel floor, one dot per person per day.",
    blurb:
      "Everyone drops one coloured dot a day. Nobody sees who dropped which, but the floor sees its own weather. The warden sees a week of it and nothing more.",
    tags: ["Expo", "Supabase"],
    members: [
      { name: "Zara", seed: "zara" },
      { name: "Aditya", seed: "aditya" },
    ],
    links: {},
  },
  {
    id: "marginalia",
    name: "Marginalia",
    team: "Footnote",
    track: "Open",
    tagline: "Annotations that live on any PDF and follow you across devices.",
    blurb:
      "Highlights are keyed to the text, not the page, so a re-export of the same paper keeps them. Share a link and the other reader sees your margins beside theirs.",
    tags: ["Rust", "WASM", "React"],
    members: [
      { name: "Sahil", seed: "sahil" },
      { name: "Diya", seed: "diya" },
      { name: "Kunal", seed: "kunal" },
      { name: "Nisha", seed: "nisha" },
    ],
    links: { github: "https://github.com" },
  },
];

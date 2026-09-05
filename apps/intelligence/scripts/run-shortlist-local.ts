import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { URL } from "node:url";
import assert from "node:assert/strict";
import {
  selectAdmissionShortlist,
  shortlistCandidateInputSchema,
  shortlistNeighbourPairs,
  shortlistPairSchema,
  shortlistAuditSchema,
  shortlistProfileSchema,
  shortlistVersion,
  type ShortlistCandidateInput,
  type ShortlistComparison,
} from "@code2create/domain";
import {
  analyzeShortlistTask,
  embedShortlistProfile,
} from "../src/lib/shortlistModel.ts";

const { values } = parseArgs({
  options: {
    input: { type: "string" },
    "sample-seed": { type: "string" },
    "accept-people": { type: "string", default: "8" },
    "waitlist-people": { type: "string", default: "4" },
    "remaining-capacity": { type: "string", default: "850" },
    model: { type: "string", default: "gpt-5.6-terra" },
    output: { type: "string", default: "../../outputs/shortlist-local" },
  },
});
const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey)
  throw new Error(
    "OPENAI_API_KEY is required; credentials are never written to the report.",
  );
const settings = {
  acceptPeople: Number(values["accept-people"]),
  waitlistPeople: Number(values["waitlist-people"]),
  remainingCapacity: Number(values["remaining-capacity"]),
  tolerance: 5,
};
if (Object.values(settings).some((n) => !Number.isSafeInteger(n) || n < 0))
  throw new Error("People targets must be nonnegative integers");
const criteria = [
  {
    criterionKey: "problem_clarity",
    label: "Problem clarity",
    guidance:
      "Name a concrete user and a specific problem; first-year proposals need not prove market demand.",
  },
  {
    criterionKey: "solution_coherence",
    label: "Solution coherence",
    guidance:
      "Explain how the proposed inputs and steps address the problem. Naming a technology alone is not an explanation.",
  },
  {
    criterionKey: "feasibility",
    label: "Event-sized scope",
    guidance:
      "Describe a bounded prototype, its needed inputs and a way to check its intended outcome. Production completeness is not required.",
  },
  {
    criterionKey: "differentiation",
    label: "Meaningful distinction",
    guidance:
      "Explain one concrete difference for the chosen context; global novelty is not required.",
  },
];
function fixture(
  applicationId: string,
  idea: string,
  answers: [string, string, string, string],
  quality: ShortlistCandidateInput["quality"] = "accept",
): ShortlistCandidateInput {
  return {
    applicationId,
    teamSize: 4,
    experienceBand: "first_year",
    quality,
    criteria,
    sources: [
      { sourceRef: "initial_idea", question: "Initial idea", answer: idea },
      ...answers.map((answer, i) => ({
        sourceRef: `follow_up_${i + 1}`,
        question:
          [
            "What problem are you solving?",
            "How does the solution work?",
            "What will you demonstrate?",
            "What makes your approach different?",
          ][i] ?? "Follow-up",
        answer,
      })),
    ],
  };
}
let candidates: ShortlistCandidateInput[] = [
  fixture(
    "surplus-strong",
    "Canteens post surplus meal portions for nearby volunteers to collect before their pickup deadline.",
    [
      "Canteen managers cannot find a collector before cooked meals must be discarded.",
      "A manager enters portion count, location, allergen notes and pickup deadline. A volunteer claims a lot; a transactional claim prevents two pickups. Staff confirm handoff using a one-time code. Expired lots disappear, and no food-safety certification is claimed.",
      "Build listing, claim and handoff states using test lots. Simulate concurrent claims, expirations and no-shows; a missed pickup reopens the lot before its deadline.",
      "Focus on short campus pickup windows, explicit allergen information and acknowledgement of handoff rather than an unbounded city-wide delivery marketplace.",
    ],
  ),
  fixture(
    "surplus-alternative",
    "A campus surplus food board matches available portions with student collectors.",
    [
      "Campus canteens have spare portions and volunteers do not know what is available.",
      "Canteen staff post portions and pickup times. Students claim listings and mark them picked up. We will use a database and a web interface.",
      "Demonstrate one posting, one claim and a completed pickup using fictional meals.",
      "Our focus is the campus canteen collection workflow instead of restaurant discounts.",
    ],
  ),
  fixture(
    "accessible-room",
    "An accessible campus room finder with verified step-free routes and lift outage notices.",
    [
      "Wheelchair users cannot tell whether a room can currently be reached without stairs.",
      "Facilities staff record ramps, lift links and outages in a small route graph. Filter edges by current accessibility and find a route. If all step-free routes are blocked, report no verified route instead of inventing one.",
      "Map two fictional buildings manually, close a lift edge, and demonstrate rerouting or no-route results. Volunteers check our route descriptions against the fixture map.",
      "A room's accessibility changes when a connecting lift fails; we report the entire route, not just a building accessibility label.",
    ],
  ),
  fixture("dating", "A romantic dating app for students with mutual matches.", [
    "Students want to find romantic partners nearby.",
    "Users set dating preferences, like profiles and chat after mutual likes.",
    "Build profile, mutual matching and chat with sample accounts.",
    "It is focused on dating within one campus.",
  ]),
  fixture(
    "blood-from-name",
    "Predict a person's blood group accurately from their first name using AI.",
    [
      "People sometimes do not remember their blood group.",
      "Users type a first name. An AI model detects hidden name patterns and immediately returns A, B, AB or O. The name is our only input.",
      "Build a form and display the prediction; we plan to ask clinics for data later.",
      "No blood sample, records or family history is needed because AI discovers patterns humans cannot see.",
    ],
  ),
  fixture(
    "pet-reminders",
    "A pet-care organizer so owners never miss a vaccination again.",
    [
      "Owners lose track of vaccination dates and medication schedules across paper records.",
      "An owner creates a pet profile and enters dates from the vet's prescription. The app stores those dates, schedules reminders and lets the owner mark doses completed. It does not prescribe treatments.",
      "Create a pet, add a vaccination date, advance a test clock and show the reminder and recorded completion.",
      "Keep multiple pets' schedules separate and share the entered schedule with household caregivers.",
    ],
  ),
  fixture(
    "bounded-memory-queue",
    "Crash-proof local model serving for student laptops.",
    [
      "Concurrent requests to a local model can exceed a laptop's available memory.",
      "A local server queues requests, enforces a configured context limit and limits active batches using measured free memory and per-request estimates. It rejects oversized requests and records allocation failures. Quantization reduces model memory use.",
      "Load one model, submit a bounded test workload and display queue length, observed memory and allocation failures. Compare the same workload with uncontrolled concurrency.",
      "A local-only diagnostic view makes the tradeoff between memory and waiting visible on one laptop, without claiming support for every model or device.",
    ],
  ),
  fixture(
    "quality-decline-control",
    "A basic room booking calendar.",
    [
      "Room users need to see free times.",
      "A database stores bookings and rejects conflicting reservations.",
      "Demonstrate two conflicting reservations.",
      "No distinction beyond a standard calendar is submitted.",
    ],
    "decline",
  ),
];
const assumptions: string[] = values.input
  ? []
  : [
      "Calibration fixtures, not a real admissions allocation.",
      "Four-person first-year teams, illustrative criteria and scripted individual quality labels. These are not inferred facts about real applicants.",
    ];
if (values.input) {
  const value: unknown = JSON.parse(
    await readFile(resolve(values.input), "utf8"),
  );
  if (!Array.isArray(value) || value.length < 1 || value.length > 1000)
    throw new Error(
      "Input must contain 1–1000 frozen candidates with locked sizes, guidance and current individual quality labels",
    );
  candidates = value.map((row) => shortlistCandidateInputSchema.parse(row));
}
if (values["sample-seed"]) {
  if (values.input)
    throw new Error(
      "Choose a complete input or the calibration seed sample, not both",
    );
  const value: unknown = JSON.parse(
    await readFile(resolve(values["sample-seed"]), "utf8"),
  );
  if (!Array.isArray(value)) throw new Error("Invalid idea seed");
  const rows: unknown[] = value;
  for (const row of rows) {
    if (
      typeof row !== "object" ||
      row === null ||
      !("answers" in row) ||
      !Array.isArray(row.answers)
    )
      continue;
    const answers: Array<{ ordinal: number; prompt: string; answer: string }> =
      [];
    const rawAnswers: unknown[] = row.answers;
    for (const answer of rawAnswers) {
      if (
        typeof answer !== "object" ||
        answer === null ||
        !("ordinal" in answer) ||
        !("prompt" in answer) ||
        !("answer" in answer) ||
        typeof answer.ordinal !== "number" ||
        typeof answer.prompt !== "string" ||
        typeof answer.answer !== "string"
      )
        throw new Error("Invalid seed answer");
      answers.push({
        ordinal: answer.ordinal,
        prompt: answer.prompt,
        answer: answer.answer,
      });
    }
    if (!answers.some((a) => a.ordinal === 0 && a.answer.includes("CoughTB")))
      continue;
    const sources = answers
      .sort((a, b) => a.ordinal - b.ordinal)
      .map((a) => ({
        sourceRef:
          a.ordinal === 0
            ? "initial_idea"
            : a.ordinal <= 4
              ? `follow_up_${a.ordinal}`
              : "additional_information",
        question: a.prompt,
        answer: a.answer
          .replace(/https?:\/\/\S+/gu, "[link not evaluated]")
          .replace(
            /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu,
            "[email removed]",
          )
          .replace(/(?:\+?\d[\s().-]*){8,15}/gu, "[identifier removed]"),
      }));
    candidates.push(
      shortlistCandidateInputSchema.parse({
        applicationId: "seed-cough-example",
        teamSize: 4,
        experienceBand: "first_year",
        quality: "accept",
        criteria,
        sources,
      }),
    );
    assumptions.push(
      "Cough example uses all exported answers but hypothetical team size, experience guidance and an Accept quality label to isolate premise checking; it is not a real team decision.",
    );
    break;
  }
}
if (new Set(candidates.map((c) => c.applicationId)).size !== candidates.length)
  throw new Error("Duplicate candidate identities");
const output = resolve(values.output);
await mkdir(output, { recursive: true });
const release = createHash("sha256")
  .update(
    (
      await Promise.all(
        [
          "../src/lib/shortlistModel.ts",
          "../../../packages/domain/src/admissionShortlist.ts",
        ].map((path) => readFile(new URL(path, import.meta.url), "utf8")),
      )
    ).join("\n"),
  )
  .digest("hex");
const inputHash = createHash("sha256")
  .update(
    JSON.stringify({
      candidates,
      settings,
      version: shortlistVersion,
      release,
      model: values.model,
    }),
  )
  .digest("hex");
const directory = resolve(output, inputHash.slice(0, 16));
await mkdir(directory, { recursive: true });
// Local private evaluation artifacts, not production telemetry. They contain
// bounded model findings but no raw source answers or provider credentials.
async function cached<T>(
  name: string,
  compute: () => Promise<T>,
  parse: (value: unknown) => T,
): Promise<T> {
  const path = resolve(directory, `${name}.json`);
  try {
    return parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ENOENT"
    )
      throw error;
  }
  const result = parse(await compute());
  await writeFile(path, JSON.stringify(result, null, 2), { mode: 0o600 });
  return result;
}
const profiled: Array<
  ShortlistCandidateInput & {
    profile: ReturnType<typeof shortlistProfileSchema.parse>;
    embedding: number[];
  }
> = [];
for (const [index, candidate] of candidates.entries()) {
  const profile = shortlistProfileSchema.parse(
    await cached(
      `profile-${index}`,
      () =>
        analyzeShortlistTask({
          task: { kind: "profile", candidate },
          modelId: values.model,
          apiKey,
        }),
      shortlistProfileSchema.parse,
    ),
  );
  const embedding = await cached(
    `embedding-${index}`,
    () =>
      embedShortlistProfile(
        [
          profile.user,
          profile.problem,
          profile.workflow,
          profile.mechanism,
          profile.distinction,
        ].join("\n"),
        apiKey,
      ),
    parseEmbedding,
  );
  profiled.push({ ...candidate, profile, embedding });
  console.log(
    JSON.stringify({
      stage: "profiles",
      completed: index + 1,
      total: candidates.length,
    }),
  );
}
const comparable = profiled.filter(
  (c) =>
    c.quality !== "decline" &&
    c.profile.premise.assessment === "supported" &&
    !c.profile.category.datingOrRomanticMatchmaking,
);
const comparisons: ShortlistComparison[] = [];
const pairs = shortlistNeighbourPairs(comparable);
for (const [index, pair] of pairs.entries()) {
  const left = candidates.find((c) => c.applicationId === pair.leftId);
  const right = candidates.find((c) => c.applicationId === pair.rightId);
  if (!left || !right) throw new Error("Invalid pair");
  const result = shortlistPairSchema.parse(
    await cached(
      `pair-${index}`,
      () =>
        analyzeShortlistTask({
          task: { kind: "pair", left, right },
          modelId: values.model,
          apiKey,
        }),
      shortlistPairSchema.parse,
    ),
  );
  comparisons.push({ ...pair, ...result });
  console.log(
    JSON.stringify({
      stage: "comparisons",
      completed: index + 1,
      total: pairs.length,
    }),
  );
}
const suggestions = selectAdmissionShortlist(profiled, comparisons, settings);
if (!values.input) {
  for (const id of ["pet-reminders", "bounded-memory-queue", "accessible-room"]) {
    assert.equal(
      profiled.find((candidate) => candidate.applicationId === id)?.profile.premise.assessment,
      "supported",
      `${id}: a credible described core must not fail on an exaggerated benefit`,
    );
  }
  for (const id of [
    "dating",
    "blood-from-name",
    "quality-decline-control",
    ...(values["sample-seed"] ? ["seed-cough-example"] : []),
  ]) {
    assert.equal(
      suggestions.find((suggestion) => suggestion.applicationId === id)?.suggestion,
      "reject",
      `${id}: policy exclusion must survive selection`,
    );
  }
  const overlap = comparisons.find(
    (comparison) =>
      [comparison.leftId, comparison.rightId].includes("surplus-strong") &&
      [comparison.leftId, comparison.rightId].includes("surplus-alternative"),
  );
  assert.ok(overlap, "Missing known overlap comparison");
  assert.equal(overlap.overlap, "substantial");
  assert.equal(
    overlap.preferred === "left" ? overlap.leftId : overlap.preferred === "right" ? overlap.rightId : "tie",
    "surplus-strong",
    "Concrete handoff and concurrency evidence must win the direct comparison",
  );
}
const audits: unknown[] = [];
for (let offset = 0; offset < suggestions.length; offset += 8) {
  const rows = suggestions.slice(offset, offset + 10).map((s) => {
    const c = profiled.find((c) => c.applicationId === s.applicationId);
    if (!c) throw new Error("Missing profile");
    return {
      applicationId: s.applicationId,
      suggestion: s.suggestion,
      profile: c.profile,
    };
  });
  audits.push(
    await cached(
      `audit-${offset}`,
      () =>
        analyzeShortlistTask({
          task: { kind: "audit", candidates: rows },
          modelId: values.model,
          apiKey,
        }),
      shortlistAuditSchema.parse,
    ),
  );
}
const totals = Object.fromEntries(
  ["accept", "waitlist", "reject", "unresolved"].map((kind) => [
    kind,
    {
      teams: suggestions.filter((r) => r.suggestion === kind).length,
      people: suggestions
        .filter((r) => r.suggestion === kind)
        .reduce((n, r) => n + r.teamSize, 0),
    },
  ]),
);
await writeFile(
  resolve(directory, "report.json"),
  JSON.stringify(
    {
      version: shortlistVersion,
      model: values.model,
      inputHash,
      assumptions,
      settings,
      totals,
      suggestions,
      comparisons,
      audits,
      profiles: profiled.map((c) => ({
        applicationId: c.applicationId,
        originalQuality: c.quality,
        profile: c.profile,
      })),
    },
    null,
    2,
  ),
  { mode: 0o600 },
);
console.log(
  JSON.stringify(
    {
      stage: "complete",
      totals,
      report: resolve(directory, "report.json"),
      assumptions,
    },
    null,
    2,
  ),
);

function parseEmbedding(value: unknown): number[] {
  if (!Array.isArray(value) || value.length !== 1536)
    throw new Error("Invalid embedding cache");
  return value.map((n) => {
    if (typeof n !== "number" || !Number.isFinite(n))
      throw new Error("Invalid embedding cache");
    return n;
  });
}

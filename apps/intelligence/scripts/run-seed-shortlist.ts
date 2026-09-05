import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { URL } from "node:url";
import { defaultAdmissionCriteria } from "../../backend/convex/lib/admissionPolicy.ts";
import { redactProjectText } from "../../backend/convex/lib/projectText.ts";
import {
  selectAdmissionShortlist,
  ideaIntelligenceAnalysisPolicyViolation,
  shortlistCandidateInputSchema,
  shortlistLocalQualitySchema,
  shortlistNeighbourPairs,
  shortlistPairSchema,
  shortlistAuditSchema,
  shortlistProfileSchema,
  shortlistVersion,
  validateShortlistProfile,
  validateShortlistPair,
  type ShortlistCandidateInput,
} from "@code2create/domain";
import {
  analyzeShortlistTask,
  embedShortlistProfile,
  evaluateLocalShortlistQuality,
} from "../src/lib/shortlistModel.ts";

const { values } = parseArgs({
  options: {
    seed: {
      type: "string",
      default: "../../outputs/data/admissions-review-seed-source.json",
    },
    output: { type: "string", default: "../../outputs/shortlist-seed" },
    model: { type: "string", default: "gpt-5.6-terra" },
    concurrency: { type: "string", default: "12" },
    "accept-people": { type: "string", default: "700" },
    "waitlist-people": { type: "string", default: "300" },
    "assumed-team-size": { type: "string", default: "4" },
    limit: { type: "string" },
    "quality-from": { type: "string" },
  },
});
const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey)
  throw new Error(
    "OPENAI_API_KEY is required. This runner never contacts Convex.",
  );
const concurrency = Number(values.concurrency);
const assumedSize = Number(values["assumed-team-size"]);
if (
  !Number.isInteger(concurrency) ||
  concurrency < 1 ||
  concurrency > 32 ||
  !Number.isInteger(assumedSize) ||
  assumedSize < 2 ||
  assumedSize > 5
)
  throw new Error(
    "Use concurrency 1–32 and a labelled simulated team size 2–5",
  );
const settings = {
  acceptPeople: Number(values["accept-people"]),
  waitlistPeople: Number(values["waitlist-people"]),
  remainingCapacity: Number(values["accept-people"]) + 5,
  tolerance: 5,
};
if (Object.values(settings).some((n) => !Number.isSafeInteger(n) || n < 0))
  throw new Error("Invalid targets");
const raw: unknown = JSON.parse(await readFile(resolve(values.seed), "utf8"));
if (!Array.isArray(raw)) throw new Error("The seed must be an array");
const seedRows: unknown[] = raw;
const labels = new Map<string, string>();
const inputs: ShortlistCandidateInput[] = [];
for (const [index, row] of seedRows.entries()) {
  if (
    typeof row !== "object" ||
    row === null ||
    !("teamName" in row) ||
    typeof row.teamName !== "string" ||
    !("applicationId" in row) ||
    typeof row.applicationId !== "string" ||
    !("answers" in row) ||
    !Array.isArray(row.answers)
  )
    throw new Error("Malformed seed entry");
  const id = `seed-${String(index + 1).padStart(4, "0")}`;
  const teamName = row.teamName;
  labels.set(id, teamName);
  const sources: ShortlistCandidateInput["sources"] = [];
  const answers: unknown[] = row.answers;
  for (const a of answers) {
    if (
      typeof a !== "object" ||
      a === null ||
      !("ordinal" in a) ||
      typeof a.ordinal !== "number" ||
      !("prompt" in a) ||
      typeof a.prompt !== "string" ||
      !("answer" in a) ||
      typeof a.answer !== "string"
    )
      throw new Error("Malformed seed answer");
    const clean = (s: string) =>
      redactProjectText(s)
        .replaceAll(teamName, "[project]")
        .replace(/https?:\/\/\S+/gu, "[link not evaluated]");
    sources.push({
      sourceRef:
        a.ordinal === 0
          ? "initial_idea"
          : a.ordinal <= 4
            ? `follow_up_${a.ordinal}`
            : "additional_information",
      question: clean(a.prompt),
      answer: clean(a.answer),
    });
  }
  if (
    ![
      "initial_idea",
      "follow_up_1",
      "follow_up_2",
      "follow_up_3",
      "follow_up_4",
    ].every((ref) => sources.some((s) => s.sourceRef === ref))
  )
    throw new Error("Seed entry lacks one of its four follow-up answers");
  inputs.push(
    shortlistCandidateInputSchema.parse({
      applicationId: id,
      teamSize: assumedSize,
      experienceBand: "first_year",
      quality: "accept",
      sources,
      criteria: defaultAdmissionCriteria.map((c) => ({
        criterionKey: c.criterionKey,
        label: c.label,
        guidance: c.guidanceByBand.firstYear,
      })),
    }),
  );
}
if (values.limit !== undefined) {
  const limit = Number(values.limit);
  if (!Number.isInteger(limit) || limit < 1) throw new Error("Invalid limit");
  inputs.splice(limit);
}
const codeFiles = [
  "../src/lib/shortlistModel.ts",
  "../../../packages/domain/src/admissionShortlist.ts",
  "../../../packages/domain/src/intelligenceAgents.ts",
].map((path) => new URL(path, import.meta.url));
const release = createHash("sha256")
  .update(
    (await Promise.all(codeFiles.map((path) => readFile(path, "utf8")))).join(
      "\n",
    ),
  )
  .digest("hex");
let qualitySource: {
  directory: string;
  fingerprint: string;
  release: string;
} | null = null;
if (values["quality-from"]) {
  const sourceDirectory = resolve(values["quality-from"]);
  const prior: unknown = JSON.parse(
    await readFile(resolve(sourceDirectory, "manifest.json"), "utf8"),
  );
  if (
    typeof prior !== "object" ||
    prior === null ||
    !("fingerprint" in prior) ||
    typeof prior.fingerprint !== "string" ||
    !("release" in prior) ||
    typeof prior.release !== "string"
  )
    throw new Error("Invalid original quality-run manifest");
  const expected = createHash("sha256")
    .update(
      JSON.stringify({
        inputs,
        settings,
        model: values.model,
        release: prior.release,
      }),
    )
    .digest("hex");
  if (prior.fingerprint !== expected)
    throw new Error(
      "Frozen quality requires the identical seed, model, criteria, assumptions and targets from an original assessment run",
    );
  qualitySource = {
    directory: sourceDirectory,
    fingerprint: prior.fingerprint,
    release: prior.release,
  };
}
const fingerprint = createHash("sha256")
  .update(
    JSON.stringify({
      inputs,
      settings,
      model: values.model,
      release,
      ...(qualitySource ? { qualitySource: qualitySource.fingerprint } : {}),
    }),
  )
  .digest("hex");
const directory = resolve(values.output, fingerprint.slice(0, 16));
await mkdir(directory, { recursive: true });
const assumptions = [
  "Local calibration only: no Convex access or production decisions.",
  "Published event policy, experience bands, locked rosters and existing AI results are absent from the seed.",
  `Uses repository-default first-year criteria for everyone and ${assumedSize}-person simulated teams. People totals are NOT actual participant counts.`,
  qualitySource
    ? `Individual quality is frozen from local run ${qualitySource.fingerprint}; it is preserved, not re-evaluated under this run's prompts. Historical similarity was unavailable during that original calibration.`
    : `Individual quality is freshly evaluated with the existing rubric and recommendation ladder; historical similarity tools are unavailable and limitations must be recorded.`,
];
await writeFile(
  resolve(directory, "manifest.json"),
  JSON.stringify(
    {
      fingerprint,
      release,
      version: shortlistVersion,
      model: values.model,
      settings,
      assumptions,
      qualitySource,
      teams: inputs.map((c) => ({
        applicationId: c.applicationId,
        teamName: labels.get(c.applicationId),
      })),
    },
    null,
    2,
  ),
  { mode: 0o600 },
);
async function cache<T>(
  key: string,
  compute: () => Promise<T>,
  parse: (value: unknown) => T,
): Promise<T> {
  const path = resolve(directory, `${key}.json`);
  try {
    return parse(JSON.parse(await readFile(path, "utf8")));
  } catch (e) {
    if (!(e instanceof Error) || !("code" in e) || e.code !== "ENOENT") throw e;
  }
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++)
    try {
      const result = parse(await compute());
      await writeFile(path, JSON.stringify(result, null, 2), { mode: 0o600 });
      return result;
    } catch (e) {
      last = e;
      console.log(
        JSON.stringify({ stage: "retry", task: key, attempt: attempt + 1 }),
      );
      await new Promise((r) => {
        setTimeout(r, 1000 * (attempt + 1));
      });
    }
  throw last;
}
async function parallel<T, R>(
  stage: string,
  rows: T[],
  work: (row: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  let completed = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, rows.length) }, async () => {
      for (;;) {
        const i = next++;
        const row = rows[i];
        if (row === undefined) return;
        results[i] = await work(row, i);
        completed++;
        if (completed % 10 === 0 || completed === rows.length)
          console.log(JSON.stringify({ stage, completed, total: rows.length }));
      }
    }),
  );
  return results;
}
const failures: Array<{ stage: string; applicationId: string }> = [];
const qualityResults = await parallel("quality", inputs, async (c) => {
  try {
    const result = shortlistLocalQualitySchema(c).parse(
      await cache(
        `quality-${c.applicationId}`,
        () =>
          qualitySource
            ? readFile(
                resolve(
                  qualitySource.directory,
                  `quality-${c.applicationId}.json`,
                ),
                "utf8",
              ).then((text) =>
                shortlistLocalQualitySchema(c).parse(JSON.parse(text)),
              )
            : evaluateLocalShortlistQuality({
                candidate: c,
                modelId: values.model,
                apiKey,
              }),
        shortlistLocalQualitySchema(c).parse,
      ),
    );
    if (
      ideaIntelligenceAnalysisPolicyViolation({
        analysis: result,
        criterionKeys: c.criteria.map((criterion) => criterion.criterionKey),
        sourceRefs: c.sources.map((source) => source.sourceRef),
      })
    )
      throw new Error("Invalid frozen individual assessment");
    return result;
  } catch {
    failures.push({ stage: "quality", applicationId: c.applicationId });
    return null;
  }
});
const qualityInputs = inputs.map((c, i) => ({
  ...c,
  quality: qualityResults[i]?.recommendation ?? "accept",
}));
const candidates = await parallel("profiles", qualityInputs, async (c) => {
  if (
    c.quality === "decline" ||
    !qualityResults[
      inputs.findIndex((i) => i.applicationId === c.applicationId)
    ]
  )
    return { ...c, profile: null, embedding: [] };
  try {
    const profile = shortlistProfileSchema.parse(
      await cache(
        `profile-${c.applicationId}`,
        () =>
          analyzeShortlistTask({
            task: { kind: "profile", candidate: c },
            modelId: values.model,
            apiKey,
          }),
        shortlistProfileSchema.parse,
      ),
    );
    validateShortlistProfile(profile, c);
    const embedding = await cache(
      `embedding-${c.applicationId}`,
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
    return { ...c, profile, embedding };
  } catch {
    failures.push({ stage: "profile", applicationId: c.applicationId });
    return { ...c, profile: null, embedding: [] };
  }
});
const comparable = candidates.flatMap((c) =>
  c.profile?.premise.assessment === "supported" &&
  !c.profile.category.datingOrRomanticMatchmaking
    ? [{ ...c, profile: c.profile }]
    : [],
);
const pairs = shortlistNeighbourPairs(comparable);
const comparisons = await parallel("comparisons", pairs, async (p) => {
  const left = qualityInputs.find((c) => c.applicationId === p.leftId);
  const right = qualityInputs.find((c) => c.applicationId === p.rightId);
  if (!left || !right) throw new Error("Missing pair");
  const comparison = shortlistPairSchema.parse(
    await cache(
      `pair-${p.leftId}-${p.rightId}`,
      () =>
        analyzeShortlistTask({
          task: { kind: "pair", left, right },
          modelId: values.model,
          apiKey,
        }),
      shortlistPairSchema.parse,
    ),
  );
  validateShortlistPair(comparison, left, right);
  return { ...p, ...comparison };
});
const suggestions = selectAdmissionShortlist(candidates, comparisons, settings);
const auditInputs = suggestions.flatMap((s) => {
  const c = candidates.find((c) => c.applicationId === s.applicationId);
  return c?.profile
    ? [
        {
          applicationId: s.applicationId,
          suggestion: s.suggestion,
          profile: c.profile,
        },
      ]
    : [];
});
const chunks = Array.from(
  { length: Math.ceil(auditInputs.length / 8) },
  (_, i) => auditInputs.slice(i * 8, i * 8 + 10),
);
const audits = await parallel("audit", chunks, (rows, i) =>
  cache(
    `audit-${i}`,
    () =>
      analyzeShortlistTask({
        task: { kind: "audit", candidates: rows },
        modelId: values.model,
        apiKey,
      }),
    shortlistAuditSchema.parse,
  ),
);
const totals = Object.fromEntries(
  ["accept", "waitlist", "reject", "unresolved"].map((kind) => [
    kind,
    {
      teams: suggestions.filter((r) => r.suggestion === kind).length,
      simulatedPeople: suggestions
        .filter((r) => r.suggestion === kind)
        .reduce((n, r) => n + r.teamSize, 0),
    },
  ]),
);
const report = {
  fingerprint,
  release,
  model: values.model,
  assumptions,
  qualitySource,
  settings,
  totals,
  failures,
  comparisons,
  audits,
  teams: suggestions.map((s) => {
    const index = inputs.findIndex((c) => c.applicationId === s.applicationId);
    return {
      ...s,
      teamName: labels.get(s.applicationId),
      quality: qualityResults[index],
      profile: candidates[index]?.profile ?? null,
    };
  }),
};
const accepted = report.teams.filter((team) => team.suggestion === "accept");
const domainMix = Object.fromEntries(
  [
    ...new Set(
      accepted.flatMap((team) => (team.profile ? [team.profile.domain] : [])),
    ),
  ]
    .sort()
    .map((domain) => [
      domain,
      accepted.filter((team) => team.profile?.domain === domain).length,
    ]),
);
const aiMix = Object.fromEntries(
  ["none", "supporting", "core"].map((role) => [
    role,
    accepted.filter((team) => team.profile?.aiRole === role).length,
  ]),
);
const displaced = report.teams.filter(
  (team) =>
    team.quality?.recommendation === "accept" && team.suggestion !== "accept",
);
const describeTeam = (team: (typeof report.teams)[number]) =>
  `- ${team.teamName} (${team.applicationId}) — ${team.suggestion}, ${team.reason}. ${team.profile?.problem ?? "No profile; see individual concerns."} ${team.profile?.mechanism ?? ""}\n  - Original quality: ${team.quality?.recommendation ?? "unresolved"}; premise: ${team.profile?.premise.assessment ?? "not profiled"}. ${team.profile?.premise.explanation ?? team.quality?.concerns.join(" ") ?? "No assessment"}${team.preferredApplicationIds.length ? `\n  - Preferred overlapping alternative(s): ${team.preferredApplicationIds.map((id) => labels.get(id) ?? id).join(", ")}` : ""}`;
await writeFile(
  resolve(directory, "report.json"),
  JSON.stringify({ ...report, domainMix, aiMix }, null, 2),
  { mode: 0o600 },
);
await writeFile(
  resolve(directory, "review.md"),
  `# Local seed shortlist calibration\n\n${assumptions.map((a) => `- ${a}`).join("\n")}\n\n## Totals\n\n| Suggestion | Teams | Simulated people |\n| --- | ---: | ---: |\n${Object.entries(
    totals,
  )
    .map(
      ([kind, counts]) =>
        `| ${kind} | ${counts.teams} | ${counts.simulatedPeople} |`,
    )
    .join(
      "\n",
    )}\n\nAccepted domains (teams): ${JSON.stringify(domainMix)}\n\nAccepted AI roles (teams): ${JSON.stringify(aiMix)}\n\n${[
    "accept",
    "waitlist",
    "reject",
    "unresolved",
  ]
    .map(
      (kind) =>
        `## ${kind}\n\n${report.teams
          .filter((t) => t.suggestion === kind)
          .map(describeTeam)
          .join("\n")}`,
    )
    .join("\n\n")}\n`,
  { mode: 0o600 },
);
await writeFile(
  resolve(directory, "boundary-review.md"),
  `# Qualifying ideas displaced or flagged\n\nThese ${displaced.length} teams passed the original individual rubric but did not enter Accept. This is an inspection list, not a claim that each should be accepted. Whole-team capacity, direct overlap, premise and category checks still apply.\n\n${displaced.map(describeTeam).join("\n\n")}\n\n## Independent audit\n\n${
    audits
      .flatMap((audit) => shortlistAuditSchema.parse(audit).warnings)
      .map(
        (warning) =>
          `- ${warning.applicationIds.map((id) => labels.get(id) ?? id).join(", ")}: ${warning.explanation}`,
      )
      .join("\n") || "No warnings in the bounded audit slices."
  }\n`,
  { mode: 0o600 },
);
console.log(
  JSON.stringify(
    { stage: "complete", totals, report: resolve(directory, "report.json") },
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

import Papa from "papaparse";
import type { FunctionArgs } from "convex/server";
import type { api } from "@code2create/backend/api";

export type RosterCsvRow = FunctionArgs<
  typeof api.rosters.previewImport
>["rows"][number];
export const maximumRosterRows = 200;
const roles = new Map<string, RosterCsvRow["role"]>([
  ["supreme", "supreme"],
  ["board", "board"],
  ["board_member", "board"],
  ["sc", "sc"],
  ["senior_core", "sc"],
  ["jc", "jc"],
  ["junior_core", "jc"],
  ["external_judge", "external_judge"],
]);

export function parseRosterCsv(text: string): RosterCsvRow[] {
  const parsed = Papa.parse<string[]>(text, { skipEmptyLines: "greedy" });
  const failure = parsed.errors[0];
  if (failure) throw new Error(`CSV parsing failed: ${failure.message}`);
  const header = parsed.data[0]?.map((cell) =>
    cell
      .replace(/^\uFEFF/, "")
      .trim()
      .toLowerCase(),
  );
  if (!header) throw new Error("The roster is empty.");
  const standard = header.join(",") === "email,name,role";
  const survey =
    header.length === 9 &&
    header[0] === "timestamp" &&
    header[1] === "name" &&
    header[2]?.startsWith("email") &&
    header[3] === "position" &&
    header[4] === "domain" &&
    header[5]?.includes("skills") &&
    header[6]?.startsWith("resume") &&
    header[7] === "github" &&
    header[8]?.startsWith("availability");
  if (!standard && !survey)
    throw new Error(
      "Use email,name,role or the reviewer form export with its original headers.",
    );
  const byEmail = new Map<string, { row: RosterCsvRow; submittedAt: number }>();
  for (const [index, source] of parsed.data.slice(1).entries()) {
    const rowNumber = index + 2;
    if (source.length !== header.length)
      throw new Error(`Row ${rowNumber} does not match the header columns.`);
    const email = source[survey ? 2 : 0]?.trim().toLowerCase() ?? "";
    const displayName = source[1]?.trim() ?? "";
    const role = roles.get(
      (source[survey ? 3 : 2] ?? "")
        .trim()
        .toLowerCase()
        .replace(/[ -]+/g, "_"),
    );
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254)
      throw new Error(`Row ${rowNumber} needs a valid email.`);
    if (displayName.length < 2 || displayName.length > 100 || !role)
      throw new Error(`Row ${rowNumber} needs a name and a valid event role.`);
    if (survey && role !== "board" && role !== "sc" && role !== "jc")
      throw new Error(`Row ${rowNumber} needs Board, SC, or JC seniority.`);
    const submittedAt = survey ? formTimestamp(source[0] ?? "", rowNumber) : 0;
    const previous = byEmail.get(email);
    if (previous && (!survey || previous.submittedAt === submittedAt))
      throw new Error(
        `${email} has duplicate rows without distinct form timestamps.`,
      );
    if (previous && previous.submittedAt > submittedAt) continue;
    const row: RosterCsvRow = {
      rowNumber,
      email,
      displayName,
      role,
      ...(survey
        ? {
            reviewerDetails: {
              domain: source[4]?.trim() ?? "",
              skills: source[5]?.trim() ?? "",
              resumeUrl: source[6]?.trim() ?? "",
              githubReference: source[7]?.trim() ?? "",
            },
          }
        : {}),
    };
    // The form's availability answers (capped hour selections) are deliberately not imported.
    byEmail.set(email, { row, submittedAt });
  }
  const rows = [...byEmail.values()]
    .map(({ row }) => row)
    .sort((a, b) => a.rowNumber - b.rowNumber);
  if (rows.length === 0 || rows.length > maximumRosterRows)
    throw new Error(`Import between 1 and ${maximumRosterRows} unique people.`);
  return rows;
}

function formTimestamp(value: string, rowNumber: number) {
  const match =
    /^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2}):(\d{2})$/.exec(
      value.trim(),
    );
  if (!match)
    throw new Error(
      `Row ${rowNumber} needs the original form timestamp (MM/DD/YYYY HH:mm:ss).`,
    );
  const [, month, day, year, hour, minute, second] = match.map(Number);
  if (
    month === undefined ||
    day === undefined ||
    year === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined
  )
    throw new Error("Invalid form timestamp.");
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second
  )
    throw new Error(`Row ${rowNumber} has an invalid form timestamp.`);
  return date.getTime();
}

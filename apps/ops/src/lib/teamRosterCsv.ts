import Papa from "papaparse";

export type TeamRosterCsvRow = {
  rowNumber: number;
  identity: string;
  displayName: string;
  teamName: string;
  role: "lead" | "member";
};

export const maximumTeamRosterRows = 200;

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const vitRegistrationNumberPattern = /^\d{2}[A-Za-z]{3}\d{4}$/;

const roleByWrittenForm = new Map<string, TeamRosterCsvRow["role"]>([
  ["lead", "lead"],
  ["team_lead", "lead"],
  ["team lead", "lead"],
  ["member", "member"],
]);

export function parseTeamRosterCsv(text: string): TeamRosterCsvRow[] {
  const parsed = parsedCsv(text);
  const normalizedHeader = normalizedCsvHeader(parsed.data[0]);
  if (
    normalizedHeader?.length !== 4 ||
    normalizedHeader[0] !== "identity" ||
    normalizedHeader[1] !== "name" ||
    normalizedHeader[2] !== "team" ||
    normalizedHeader[3] !== "role"
  ) {
    throw new Error("The first CSV row must be exactly: identity,name,team,role.");
  }
  const rows: TeamRosterCsvRow[] = [];
  for (let index = 1; index < parsed.data.length; index += 1) {
    const source = parsed.data[index];
    if (!source || source.every((cell) => !cell.trim())) continue;
    requireExactColumnCount(source, index, "identity,name,team,role");
    const displayName = source[1]?.trim();
    const teamName = source[2]?.trim();
    const role = source[3] ? parsedRole(source[3]) : null;
    let identity = "";
    try {
      identity = parsedRosterIdentity(source[0] ?? "");
    } catch {
      identity = "";
    }
    if (!identity || !displayName || !teamName || !role) {
      throw new Error(
        "CSV row " +
          (index + 1) +
          " needs a Google email or VIT registration number, a name, a team name, and a role of lead or member.",
      );
    }
    if (displayName.length < 2 || displayName.length > 100) {
      throw new Error(`CSV row ${index + 1} needs a name between 2 and 100 characters.`);
    }
    if (teamName.length < 2 || teamName.length > 60) {
      throw new Error(`CSV row ${index + 1} needs a team name between 2 and 60 characters.`);
    }
    rows.push({ rowNumber: index + 1, identity, displayName, teamName, role });
  }
  return finishedRosterRows(rows);
}

export function parseTeamShapedRosterCsv(text: string): TeamRosterCsvRow[] {
  const parsed = parsedCsv(text);
  const normalizedHeader = normalizedCsvHeader(parsed.data[0]);
  if (
    normalizedHeader?.length !== 4 ||
    normalizedHeader[0] !== "team" ||
    normalizedHeader[1] !== "lead_name" ||
    normalizedHeader[2] !== "lead_identity" ||
    normalizedHeader[3] !== "member_identities"
  ) {
    throw new Error(
      "The first CSV row must be exactly: team,lead_name,lead_identity,member_identities.",
    );
  }
  const rows: TeamRosterCsvRow[] = [];
  let nextRowNumber = 2;
  const usedTeamNames = new Set<string>();
  for (let index = 1; index < parsed.data.length; index += 1) {
    const source = parsed.data[index];
    if (!source || source.every((cell) => !cell.trim())) continue;
    requireExactColumnCount(
      source,
      index,
      "team,lead_name,lead_identity,member_identities",
      "Quote member identities when the cell contains commas, or separate them with semicolons.",
    );
    const leadName = source[1]?.trim() ?? "";
    const teamName = source[0]?.trim() || leadName;
    let leadIdentity = "";
    try {
      leadIdentity = parsedRosterIdentity(source[2] ?? "");
    } catch {
      leadIdentity = "";
    }
    if (!leadIdentity || leadName.length < 2 || leadName.length > 100) {
      throw new Error(
        `CSV row ${index + 1} needs a team or lead name, a lead identity, and optional member identities.`,
      );
    }
    if (teamName.length < 2 || teamName.length > 60) {
      throw new Error(`CSV row ${index + 1} needs a team name between 2 and 60 characters.`);
    }
    if (usedTeamNames.has(teamName)) {
      throw new Error(`Team ${teamName} appears more than once in the CSV.`);
    }
    usedTeamNames.add(teamName);
    rows.push({
      rowNumber: nextRowNumber,
      identity: leadIdentity,
      displayName: leadName,
      teamName,
      role: "lead",
    });
    nextRowNumber += 1;
    for (const memberIdentity of splitMemberIdentities(source[3] ?? "")) {
      rows.push({
        rowNumber: nextRowNumber,
        identity: memberIdentity,
        displayName: memberIdentity,
        teamName,
        role: "member",
      });
      nextRowNumber += 1;
    }
  }
  return finishedRosterRows(rows);
}

function parsedCsv(text: string) {
  const parsed = Papa.parse<string[]>(text, { skipEmptyLines: false });
  const firstError = parsed.errors[0];
  if (firstError) {
    const row = firstError.row === undefined ? "" : ` on row ${firstError.row + 1}`;
    throw new Error(`CSV parsing failed${row}: ${firstError.message}`);
  }
  return parsed;
}

function normalizedCsvHeader(header: string[] | undefined) {
  return header?.map((cell, index) =>
    (index === 0 ? cell.replace(/^\uFEFF/, "") : cell).trim().toLowerCase(),
  );
}

function requireExactColumnCount(
  source: string[],
  zeroBasedIndex: number,
  expected: string,
  hint?: string,
) {
  if (source.length === 4) return;
  throw new Error(
    `CSV row ${zeroBasedIndex + 1} has ${source.length} columns; expected exactly 4 (${expected}).${hint ? ` ${hint}` : ""}`,
  );
}

function splitMemberIdentities(value: string) {
  return value
    .split(/[;,\n]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part, index) => {
      try {
        return parsedRosterIdentity(part);
      } catch {
        throw new Error(
          `Member identity ${index + 1} must be a Google email or a VIT registration number.`,
        );
      }
    });
}

function finishedRosterRows(rows: TeamRosterCsvRow[]) {
  if (rows.length === 0) throw new Error("The CSV contains no team roster rows.");
  if (rows.length > maximumTeamRosterRows) {
    throw new Error(`Import at most ${maximumTeamRosterRows} team roster rows at a time.`);
  }
  const duplicate = rows.find((row, index) =>
    rows.some(
      (candidate, candidateIndex) => candidateIndex < index && candidate.identity === row.identity,
    ),
  );
  if (duplicate) throw new Error(`${duplicate.identity} appears more than once in the CSV.`);
  const leadByTeam: Record<string, number> = {};
  for (const row of rows) {
    leadByTeam[row.teamName] = (leadByTeam[row.teamName] ?? 0) + (row.role === "lead" ? 1 : 0);
  }
  const badTeam = Object.entries(leadByTeam).find(([, leadCount]) => leadCount !== 1);
  if (badTeam) {
    throw new Error(`Team ${badTeam[0]} needs exactly one lead row. Give every team one lead.`);
  }
  return rows;
}

function parsedRosterIdentity(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.includes("@")) {
    const email = trimmed.toLowerCase();
    if (!emailPattern.test(email) || email.length > 254) {
      throw new Error(
        "Every team roster row needs a Google account email or a VIT registration number.",
      );
    }
    return email;
  }
  const registrationNumber = trimmed.toUpperCase();
  if (!vitRegistrationNumberPattern.test(registrationNumber)) {
    throw new Error(
      "Every team roster row needs a Google account email or a VIT registration number.",
    );
  }
  return registrationNumber;
}

function parsedRole(value: string) {
  return roleByWrittenForm.get(normalizedRoleText(value)) ?? null;
}

function normalizedRoleText(value: string) {
  return value.trim().toLowerCase().replace(/[ -]+/g, "_");
}

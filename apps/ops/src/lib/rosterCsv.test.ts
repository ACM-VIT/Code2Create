import assert from "node:assert/strict";
import test from "node:test";
import Papa from "papaparse";
import { parseRosterCsv } from "./rosterCsv.ts";

const header = [
  "Timestamp",
  "Name",
  "Email ID(VIT only)",
  "Position",
  "Domain",
  "Please list the skills you can review",
  "Resume",
  "Github",
  "Availability",
];
test("survey imports all reviewers, ignores constrained hour selections, and keeps latest evidence", () => {
  const input = Papa.unparse(
    [
      header,
      [
        "09/04/2026 10:00:00",
        "Reviewer One",
        "ONE@vitstudent.ac.in",
        "Senior Core",
        "Research",
        "Old skills",
        "https://drive.google.com/old",
        "one",
        "1am",
      ],
      [
        "09/04/2026 11:00:00",
        "Reviewer One",
        "one@vitstudent.ac.in",
        "Senior Core",
        "Research",
        "ML, cloud\nSystems",
        "https://drive.google.com/new",
        "https://github.com/one",
        "4am",
      ],
      [
        "09/04/2026 09:00:00",
        "Reviewer Two",
        "two@vitstudent.ac.in",
        "Junior Core",
        "Design",
        "UI/UX",
        "",
        "",
        "",
      ],
    ],
    { delimiter: "\t" },
  );
  const rows = parseRosterCsv(input);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.role, "sc");
  assert.equal(rows[0]?.reviewerDetails?.skills, "ML, cloud\nSystems");
  assert.equal(
    rows[0]?.reviewerDetails?.resumeUrl,
    "https://drive.google.com/new",
  );
  assert.equal(JSON.stringify(rows).includes("4am"), false);
  assert.equal(rows[1]?.role, "jc");
});
test("standard rosters still reject ambiguous duplicate identities and malformed roles", () => {
  assert.throws(
    () =>
      parseRosterCsv(
        "email,name,role\na@example.test,Person One,sc\na@example.test,Person Two,jc",
      ),
    /duplicate/,
  );
  assert.throws(
    () => parseRosterCsv("email,name,role\na@example.test,Person One,staff"),
    /valid event role/,
  );
  assert.equal(
    parseRosterCsv("email,name,role\na@example.test,Person One,board")[0]?.role,
    "board",
  );
});

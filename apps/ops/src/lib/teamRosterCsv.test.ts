import assert from "node:assert/strict";
import test from "node:test";

import { parseTeamRosterCsv, parseTeamShapedRosterCsv } from "./teamRosterCsv.ts";

test("parses quoted team-shaped member lists", () => {
  const rows = parseTeamShapedRosterCsv(
    'team,lead_name,lead_identity,member_identities\nAlpha,Ada,24BCI0150,"24BCI0151,24BCI0152"',
  );
  assert.deepEqual(
    rows.map((row) => row.identity),
    ["24BCI0150", "24BCI0151", "24BCI0152"],
  );
});

test("rejects an unquoted comma that creates an extra team-shaped column", () => {
  assert.throws(
    () =>
      parseTeamShapedRosterCsv(
        "team,lead_name,lead_identity,member_identities\nAlpha,Ada,24BCI0150,24BCI0151,24BCI0152",
      ),
    /row 2 has 5 columns; expected exactly 4/u,
  );
});

test("rejects extra columns in person-shaped rows too", () => {
  assert.throws(
    () => parseTeamRosterCsv("identity,name,team,role\n24BCI0150,Ada,Alpha,lead,discarded"),
    /row 2 has 5 columns; expected exactly 4/u,
  );
});

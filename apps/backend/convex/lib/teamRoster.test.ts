import { describe, expect, test } from "vitest";

import { exclusiveTeamOrigin } from "./teamRoster";

describe("exclusive team origin", () => {
  test("classifies VIT-only teams as internal and external-only teams as external", () => {
    expect(
      exclusiveTeamOrigin({ activeVitMemberCount: 4, activeExternalMemberCount: 0 }),
    ).toBe("internal");
    expect(
      exclusiveTeamOrigin({ activeVitMemberCount: 0, activeExternalMemberCount: 3 }),
    ).toBe("external");
  });

  test("mixed or empty rosters match neither filter", () => {
    expect(
      exclusiveTeamOrigin({ activeVitMemberCount: 2, activeExternalMemberCount: 1 }),
    ).toBeNull();
    expect(
      exclusiveTeamOrigin({ activeVitMemberCount: 0, activeExternalMemberCount: 0 }),
    ).toBeNull();
  });
});

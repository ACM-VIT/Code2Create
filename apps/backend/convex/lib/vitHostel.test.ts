import { defaultVitHostelResidenceCatalog } from "@code2create/domain";
import { describe, expect, test } from "vitest";

import { parsedHostelDetails } from "./vitHostel.ts";

describe("parsedHostelDetails", () => {
  test("ignores hostel input for external participants", () => {
    expect(parsedHostelDetails(
      "external_participant",
      "female",
      undefined,
      "mh_b",
      "108",
      defaultVitHostelResidenceCatalog,
    )).toEqual({
      vitResidenceType: undefined,
      vitHostelResidence: undefined,
      vitHostelRoomNumber: undefined,
    });
  });

  test("accepts men's B block and ladies' S block with a room number", () => {
    expect(parsedHostelDetails(
      "vit_student",
      "male",
      "hosteller",
      "mh_b",
      "108",
      defaultVitHostelResidenceCatalog,
    )).toEqual({
      vitResidenceType: "hosteller",
      vitHostelResidence: "mh_b",
      vitHostelRoomNumber: "108",
    });
    expect(parsedHostelDetails(
      "vit_student",
      "female",
      "hosteller",
      "lh_s",
      " 412 a ",
      defaultVitHostelResidenceCatalog,
    )).toEqual({
      vitResidenceType: "hosteller",
      vitHostelResidence: "lh_s",
      vitHostelRoomNumber: "412A",
    });
  });

  test("rejects an unknown block, a missing block, and a gender mismatch", () => {
    expect(() => parsedHostelDetails(
      "vit_student",
      "male",
      "hosteller",
      "mh_s",
      "412",
      defaultVitHostelResidenceCatalog,
    )).toThrow(
      "current VIT hostel block",
    );
    expect(() => parsedHostelDetails(
      "vit_student",
      "male",
      "hosteller",
      undefined,
      "412",
      defaultVitHostelResidenceCatalog,
    )).toThrow(
      "Choose your hostel block",
    );
    expect(() => parsedHostelDetails(
      "vit_student",
      "male",
      "hosteller",
      "lh_s",
      "412",
      defaultVitHostelResidenceCatalog,
    )).toThrow(
      "Choose a men's hostel block",
    );
  });

  test("stores day scholar status without hostel details", () => {
    expect(parsedHostelDetails(
      "vit_student",
      "female",
      "day_scholar",
      undefined,
      undefined,
      defaultVitHostelResidenceCatalog,
    )).toEqual({
      vitResidenceType: "day_scholar",
      vitHostelResidence: undefined,
      vitHostelRoomNumber: undefined,
    });
  });

  test("accepts an Ops-configured residence instead of a compiled key", () => {
    expect(parsedHostelDetails(
      "vit_student",
      "male",
      "hosteller",
      "mh_new_annex",
      "17",
      [
        { stableKey: "mh_new_annex", label: "New annex", kind: "mens" },
      ],
    )).toEqual({
      vitResidenceType: "hosteller",
      vitHostelResidence: "mh_new_annex",
      vitHostelRoomNumber: "17",
    });
  });
});

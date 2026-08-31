import { defaultVitHostelResidenceCatalog } from "@code2create/domain";
import { describe, expect, test } from "vitest";

import { parsedHostelDetails } from "./vitHostel.ts";

describe("parsedHostelDetails", () => {
  test("ignores hostel input for external participants and uncollected policy", () => {
    expect(parsedHostelDetails(
      "external_participant",
      "mh_b",
      "108",
      "required",
      defaultVitHostelResidenceCatalog,
    )).toEqual({
      vitHostelResidence: undefined,
      vitHostelRoomNumber: undefined,
    });
    expect(parsedHostelDetails(
      "vit_student",
      "mh_b",
      "108",
      "not_collected",
      defaultVitHostelResidenceCatalog,
    )).toEqual({
      vitHostelResidence: undefined,
      vitHostelRoomNumber: undefined,
    });
  });

  test("accepts men's B block and ladies' S block with a room number", () => {
    expect(parsedHostelDetails(
      "vit_student",
      "mh_b",
      "108",
      "required",
      defaultVitHostelResidenceCatalog,
    )).toEqual({
      vitHostelResidence: "mh_b",
      vitHostelRoomNumber: "108",
    });
    expect(parsedHostelDetails(
      "vit_student",
      "lh_s",
      " 412 a ",
      "required",
      defaultVitHostelResidenceCatalog,
    )).toEqual({
      vitHostelResidence: "lh_s",
      vitHostelRoomNumber: "412A",
    });
  });

  test("rejects the retired men's S block and a room without a block", () => {
    expect(() => parsedHostelDetails(
      "vit_student",
      "mh_s",
      "412",
      "required",
      defaultVitHostelResidenceCatalog,
    )).toThrow(
      "current VIT hostel block",
    );
    expect(() => parsedHostelDetails(
      "vit_student",
      undefined,
      "412",
      "optional",
      defaultVitHostelResidenceCatalog,
    )).toThrow(
      "Choose a hostel block before entering a room number",
    );
    expect(() => parsedHostelDetails(
      "vit_student",
      "day_scholar",
      "412",
      "required",
      defaultVitHostelResidenceCatalog,
    )).toThrow(
      "Day scholars do not have a hostel room number",
    );
  });

  test("accepts an Ops-configured residence instead of a compiled key", () => {
    expect(parsedHostelDetails(
      "vit_student",
      "mh_new_annex",
      "17",
      "required",
      [
        { stableKey: "day_scholar", label: "Day scholar", kind: "day_scholar" },
        { stableKey: "mh_new_annex", label: "New annex", kind: "mens" },
      ],
    )).toEqual({
      vitHostelResidence: "mh_new_annex",
      vitHostelRoomNumber: "17",
    });
  });
});

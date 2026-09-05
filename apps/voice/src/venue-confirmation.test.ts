import { describe, expect, test } from "vitest";
import { venueCallResponse } from "./venue-confirmation.js";

describe("conversational venue confirmation", () => {
  const turns = [
    { role: "user" as const, en_text: "Yes, I am at the hall and can review." },
  ];
  test("an answered call alone is not an availability confirmation", () => {
    expect(venueCallResponse(undefined, turns)).toMatchObject({
      confirmed: false,
      outcome: "unclear",
      transcript: [{ role: "user", text: turns[0]?.en_text }],
    });
    expect(
      venueCallResponse(
        {
          outcome: "available",
          confirmed: true,
          summary: "Available",
          return_in_minutes: null,
        },
        [],
      ),
    ).toMatchObject({ confirmed: false, outcome: "unclear" });
  });
  test("records the read-back answer without interpreting ambiguous words as confirmation", () => {
    expect(
      venueCallResponse(
        {
          outcome: "available",
          confirmed: true,
          summary: "At the hall and available",
          return_in_minutes: null,
        },
        turns,
      ),
    ).toMatchObject({ confirmed: true, outcome: "available" });
    expect(
      venueCallResponse(
        {
          outcome: "available",
          confirmed: "yes",
          summary: "Available",
          return_in_minutes: null,
        },
        turns,
      ),
    ).toMatchObject({ confirmed: false, outcome: "unclear" });
    expect(
      venueCallResponse(
        {
          outcome: "away",
          confirmed: false,
          summary: "Needs clarification",
          return_in_minutes: 15,
        },
        turns,
      ),
    ).toMatchObject({ confirmed: false, outcome: "away", returnInMinutes: 15 });
  });
});

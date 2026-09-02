import { describe, expect, it } from "vitest";

import {
  participantAssistantInstructions,
  participantAssistantModelId,
  participantAssistantPhaseForEvent,
  participantAssistantSuggestions,
} from "./participantAssistant";

describe("participant assistant phases", () => {
  it("uses Luna for participant help", () => {
    expect(participantAssistantModelId).toBe("gpt-5.6-luna");
  });

  it.each(["draft", "registration_open", "registration_closed"] as const)(
    "keeps %s inside idea submission help",
    (status) => {
      expect(participantAssistantPhaseForEvent({ status })).toBe(
        "idea_submission",
      );
    },
  );

  it.each(["live", "complete"] as const)(
    "uses in-event help for %s events",
    (status) => {
      expect(participantAssistantPhaseForEvent({ status })).toBe("in_event");
    },
  );

  it("keeps event-day topics out of idea-submission suggestions", () => {
    const suggestions = participantAssistantSuggestions("idea_submission");
    expect(suggestions.join(" ").toLowerCase()).not.toMatch(
      /attendance|checkpoint|schedule|venue/,
    );
  });

  it("tells the model to describe phase limits in participant language", () => {
    const instructions = participantAssistantInstructions(
      "idea_submission",
      "{}",
    );
    expect(instructions).toContain("backend language such as \"knowledge gate");
    expect(instructions).toContain("it becomes available when the event starts");
  });

  it("keeps the Guide human, practical, and free of em dashes", () => {
    const instructions = participantAssistantInstructions("in_event", "{}");
    expect(instructions).toContain("sharp, kind event volunteer sitting beside the participant");
    expect(instructions).toContain("not a support bot");
    expect(instructions).toContain("answer honestly and briefly");
    expect(instructions).toContain("Do not use em dashes");
    expect(instructions).toContain("Lead with the answer");
    expect(instructions).toContain("A factual question often needs one or two sentences");
    expect(instructions).toContain("Hindi, Hinglish, or another language");
    expect(instructions).toContain("If everything is done, say so");
    expect(instructions).not.toContain("—");
  });

  it("avoids canned support habits and oversized answers", () => {
    const instructions = participantAssistantInstructions("in_event", "{}");
    expect(instructions).toContain("Skip canned phrases");
    expect(instructions).toContain("begin with a one-sentence recap");
    expect(instructions).toContain("Stop when the participant has the answer");
    expect(instructions).toContain("Do not restate the whole question");
  });

  it("keeps the prompt outcome-first and places live context last", () => {
    const context = '{"participant":{"name":"Ishaan"}}';
    const instructions = participantAssistantInstructions("in_event", context);
    expect(instructions).toContain("ROLE\n");
    expect(instructions).toContain("SUCCESS MEANS\n");
    expect(instructions).toContain("PERSONALITY\n");
    expect(instructions).toContain("COLLABORATION\n");
    expect(instructions).toContain("RESPONSE SHAPE\n");
    expect(instructions.endsWith(context)).toBe(true);
  });

  it("leaves recommendations and schedule interpretation to the model", () => {
    const instructions = participantAssistantInstructions("in_event", "{}");
    expect(instructions).toContain(
      "Decide what matters from the raw participant, team, proposal, application, schedule",
    );
    expect(instructions).toContain(
      "There is no server-written recommendation to repeat",
    );
    expect(instructions).toContain(
      "Compare it with the published schedule",
    );
    expect(instructions).not.toContain("participant.progress");
    expect(instructions).not.toContain("schedulePosition");
  });

  it("treats a human handoff as part of the same conversation", () => {
    const instructions = participantAssistantInstructions("in_event", "{}");
    expect(instructions).toContain("Use the handoff tool according to its description");
    expect(instructions).toContain("should never have to repeat the story");
    expect(instructions).toContain("can see the context, and will reply here");
    expect(instructions).toContain("share an official contact link only if EVENT_CONTEXT supplies one");
    expect(instructions).toContain("Do not call it a ticket or give a code");
  });
});

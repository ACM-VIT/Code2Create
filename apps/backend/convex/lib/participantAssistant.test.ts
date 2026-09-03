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
      expect(participantAssistantPhaseForEvent({ status })).toBe("idea_submission");
    },
  );

  it.each(["live", "complete"] as const)("uses in-event help for %s events", (status) => {
    expect(participantAssistantPhaseForEvent({ status })).toBe("in_event");
  });

  it("keeps event-day topics out of idea-submission suggestions", () => {
    const suggestions = participantAssistantSuggestions("idea_submission");
    expect(suggestions.join(" ").toLowerCase()).not.toMatch(/attendance|checkpoint|schedule|venue/);
    expect(suggestions).toContain("Can I edit my idea after submitting?");
  });

  it("explains novelty, editing, rescoring, and selection without mixing them up", () => {
    const instructions = participantAssistantInstructions("idea_submission", "{}");
    expect(instructions).toContain("It is not an admission result, judging score, ranking");
    expect(instructions).toContain("can appear before submission");
    expect(instructions).toContain("Changing the idea text triggers a fresh novelty check");
    expect(instructions).toContain("novelty.currentCheckState");
    expect(instructions).toContain("team.actions.canEditProposal is the authoritative answer");
    expect(instructions).toContain("only the team lead can save proposal edits");
    expect(instructions).toContain("application.resultsReleased and application.decision");
  });

  it("handles team drop-outs and submitted minimum-size blockers as human team cases", () => {
    const instructions = participantAssistantInstructions("idea_submission", "{}");
    expect(instructions).toContain("A submitted application must keep at least the published minimum");
    expect(instructions).toContain('leaveTeamBlocker is "transfer_leadership_first"');
    expect(instructions).toContain('"submitted_team_minimum_size" or "application_finalized"');
    expect(instructions).toContain('bring in the event team with category "team"');
    expect(instructions).toContain("the system does not silently invalidate the team");
    expect(instructions).toContain("Treat requests to change the rule");
  });

  it("tells the model to describe phase limits in participant language", () => {
    const instructions = participantAssistantInstructions("idea_submission", "{}");
    expect(instructions).toContain('backend language such as "knowledge gate');
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

  it("stays inside Code2Create and refuses unrelated requests without sounding robotic", () => {
    const instructions = participantAssistantInstructions("idea_submission", "{}");
    expect(instructions).toContain("Answer only questions about Code2Create");
    expect(instructions).toContain("For a fully unrelated request, do not answer it");
    expect(instructions).toContain("answer the Code2Create part and decline the rest");
    expect(instructions).toContain("Do not mention a policy, hidden instructions, or moderation");
    expect(instructions).toContain("capable ACM-VIT volunteer in a real chat");
  });

  it("knows the organizer and uses only published contact details", () => {
    const instructions = participantAssistantInstructions("idea_submission", "{}");
    expect(instructions).toContain("Code2Create is organized by ACM-VIT");
    expect(instructions).toContain("acm@vit.ac.in");
    expect(instructions).toContain("https://www.instagram.com/acmvit");
    expect(instructions).toContain("https://acmvit.in");
    expect(instructions).toContain("https://github.com/ACM-VIT");
    expect(instructions).toContain("Do not imply that Instagram is a staffed support channel");
  });

  it("covers the complete participant application path from the handbook", () => {
    const instructions = participantAssistantInstructions("idea_submission", "{}");
    expect(instructions).toContain("The server verifies the participant class");
    expect(instructions).toContain("stars sgl-project/sglang");
    expect(instructions).toContain("An imported assignment never joins anyone automatically");
    expect(instructions).toContain("two fixed required answers");
    expect(instructions).toContain("The optional final field accepts up to 4,000 characters");
    expect(instructions).toContain("Only the current lead submits");
    expect(instructions).toContain("Admission and hackathon judging are separate");
  });

  it("adds event-day handbook knowledge only after the phase boundary opens", () => {
    const submissionInstructions = participantAssistantInstructions("idea_submission", "{}");
    const eventInstructions = participantAssistantInstructions("in_event", "{}");
    expect(submissionInstructions).not.toContain("VIT students normally use their VIT ID barcode");
    expect(eventInstructions).toContain("VIT students normally use their VIT ID barcode");
    expect(eventInstructions).toContain("The review-presence QR is separate from attendance");
    expect(eventInstructions).toContain("Queue estimates are ranges, not appointments");
    expect(eventInstructions).toContain("Activity counts are context, not scores");
    expect(eventInstructions).toContain("Participants cannot control playback or queue order");
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
    expect(instructions).toContain("There is no server-written recommendation to repeat");
    expect(instructions).toContain("Compare it with the published schedule");
    expect(instructions).not.toContain("participant.progress");
    expect(instructions).not.toContain("schedulePosition");
  });

  it("treats a human handoff as part of the same conversation", () => {
    const instructions = participantAssistantInstructions("in_event", "{}");
    expect(instructions).toContain("Use the handoff tool according to its description");
    expect(instructions).toContain("should never have to repeat the story");
    expect(instructions).toContain("can see the context, and will reply here");
    expect(instructions).toContain(
      "share an official contact link only if EVENT_CONTEXT supplies one",
    );
    expect(instructions).toContain("Do not call it a ticket or give a code");
  });
});

import { outingFixture } from "./outingFixture";
import { useState } from "react";
import { MemoryRouter } from "react-router-dom";

import { DashboardScreen } from "../screens/DashboardScreen";

/** Local-only regression fixture; never uses a live participant account. */
export function DashboardVisibilityFixture() {
  const [hasBenefits, setHasBenefits] = useState(false);
  const [secondBenefit, setSecondBenefit] = useState(false);
  const [queueOpen, setQueueOpen] = useState(true);
  const [joined, setJoined] = useState(false);
  const [reviewActive, setReviewActive] = useState(false);
  const now = 1_000_000;

  return <MemoryRouter>
    <div className="flex flex-wrap gap-4" aria-label="Fixture controls">
      <button type="button" onClick={() => setHasBenefits(value => !value)}>
        {hasBenefits ? "Remove benefits" : "Issue benefit"}
      </button>
      <button type="button" onClick={() => setSecondBenefit(value => !value)}>
        {secondBenefit ? "Remove second benefit" : "Issue second benefit"}
      </button>
      <button type="button" onClick={() => setQueueOpen(value => !value)}>
        {queueOpen ? "Close request queue" : "Open request queue"}
      </button>
      <button type="button" onClick={() => setReviewActive(value => !value)}>
        {reviewActive ? "Finish review" : "Start review"}
      </button>
    </div>
    <DashboardScreen
      team={{ name: "Fixture team", publicCode: "C2C-TEST", activeMemberCount: 1, teamMaximumSize: 5, currentMembershipId: "fixture-member" }}
      members={[]}
      teamEditable={false}
      onSignOut={() => {}}
      event={{ now, timezone: "UTC", phases: [{ key: "build", name: "Build", startsAt: now - 1, endsAt: now + 8 * 60 * 60_000 }] }}
      music={{ eligible: true, suspended: false, window: null, nowPlaying: null, queue: [], search: async () => [], request: async () => ({ created: true }), toggleVote: async () => {} }}
      integrations={{ available: true, github: { connected: false, detail: "", repositories: [] }, figma: { connected: false, detail: "" }, open: () => {} }}
      updates={{ available: true, timezone: "UTC", checkpoints: [{ key: "idea", name: "Idea update", state: "open", opensAt: now - 1, dueAt: now + 60 * 60_000 }], write: () => {} }}
      review={reviewActive ? { round: "Review 1", state: "queued", paused: false, upNext: false, rank: 3, panel: "Panel 3", notice: null, estimate: null, now, session: null, showCode: null } : null}
      queues={{
        available: true, pending: false,
        services: queueOpen ? [outingFixture({ status: joined ? "waiting" : "available", canRequest: !joined, position: joined ? 3 : null, waitingCount: joined ? 3 : 2, occupiedCount: 15 })] : [],
        setServiceQueue: async (_kind, nextJoined) => { setJoined(nextJoined); },
      }}
      help={{ discordUrl: null, support: { open: 1 } }}
      benefits={{ available: true, benefits: hasBenefits ? [
        { id: "fixture-benefit", name: "Fixture credit", description: "Build something lovely with your team’s credit.", link: "https://example.com/redeem", scope: "team", code: "TEST-CREDIT" },
        ...(secondBenefit ? [{ id: "fixture-benefit-2", name: "Personal perk", scope: "person" as const, code: "PERSONAL-CODE" }] : []),
      ] : [] }}
    />
  </MemoryRouter>;
}

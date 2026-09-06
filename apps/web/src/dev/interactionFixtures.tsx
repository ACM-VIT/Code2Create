// Browser regression fixtures served by Vite only; the production entry does not import this file.
import { StrictMode, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { ReviewTile, type ReviewTileModel } from "../components/dashboard/ReviewTile";
import type { MusicRequestView } from "../components/dashboard/MusicTile";
import type { MusicRoomModel } from "../lib/useMusicModel";
import { MusicRoom } from "../screens/SynesthesiaScreen";
import MemoryBoard from "../games/memory/Board";
import Pacman from "../games/pacman/Map";
import Stack from "../games/stack/Board";
import "../App.css";
import "../index.css";

function ReviewFixture() {
  const [teammate, setTeammate] = useState(false);
  const [requests, setRequests] = useState(0);
  const count = useRef(0);
  const failFirst = new URLSearchParams(location.search).has("failFirst");
  const model: ReviewTileModel = {
    round: "Midpoint review", state: "called", paused: false, upNext: false,
    panel: "Panel 3", rank: null, notice: "Bring your whole team.", estimate: null, now: 0,
    session: { status: "awaiting_presence", present: 3, total: 5 },
    showCode: {
      sessionId: "fixture-session",
      mint: async () => {
        const request = ++count.current;
        setRequests(request);
        if (failFirst && request === 1) throw new Error("Please try again.");
        return {
          payload: `c2c:review:fixture:${request}`, manualCode: `CODE-${request}`,
          serverNow: 1_700_000_000_000, expiresAt: 1_700_000_120_000,
        };
      },
    },
  };
  return <>
    <output aria-label="Codes requested">{requests}</output>
    <button type="button" onClick={() => setTeammate(value => !value)}>Toggle teammate dashboard</button>
    <div className="flex flex-wrap gap-4">
      <section aria-label="Your dashboard" className="flex h-[380px] w-[340px] [&>div]:flex-1">
        <ReviewTile slot="center" model={model} />
      </section>
      {teammate && <section aria-label="Teammate dashboard" className="flex h-[380px] w-[340px] [&>div]:flex-1">
        <ReviewTile slot="garden" model={model} />
      </section>}
    </div>
  </>;
}

function MusicFixture() {
  const [reported, setReported] = useState<{ id: string; reason: string }[]>([]);
  const attempts = useRef(0);
  const params = new URLSearchParams(location.search);
  const suspended = params.has("suspended");
  const track: MusicRequestView = {
    id: "playing-track", videoId: null, title: "Current track", artist: "Fixture artist",
    state: "playing", durationSeconds: 180, voteCount: 3, hasVoted: false,
    canVote: false, isMine: false, canReport: !suspended,
    hasReported: reported.some((report) => report.id === "playing-track"),
  };
  const model: MusicRoomModel = {
    loaded: true, eligible: true, suspended,
    window: {
      name: "Evening music", endsAt: Date.now() + 3_600_000, requestsOpen: true,
      votingOpen: true, playbackPaused: false, requestsUsed: 0, requestsAllowed: 3,
      votesUsed: 0, votesAllowed: 5,
    },
    nowPlaying: track,
    queue: params.has("queued") ? [{
      ...track, id: "queued-track", title: "Queued track", state: "queued", canVote: true,
      hasReported: reported.some((report) => report.id === "queued-track"),
    }] : [],
    search: async () => [],
    request: async () => ({ created: true }),
    toggleVote: async () => {},
    report: async (request, reason) => {
      attempts.current += 1;
      if (params.has("failFirst") && attempts.current === 1) throw new Error("Please try again.");
      setReported((current) => [...current, { id: request.id, reason }]);
    },
    confirmPendingRequest: null,
  };
  return <MemoryRouter>
    <output aria-label="Reports recorded">{JSON.stringify(reported)}</output>
    <MusicRoom
      team={{ name: "Fixture team", publicCode: "C2C-TEST", activeMemberCount: 1, teamMaximumSize: 5, currentMembershipId: "fixture-member" }}
      members={[]} teamEditable={false} onSignOut={() => {}} model={model}
    />
  </MemoryRouter>;
}

function StackFixture() {
  const [starts, setStarts] = useState(0);
  return <>
    <output aria-label="Rounds started">{starts}</output>
    <Stack onRoundStart={() => setStarts(count => count + 1)} />
  </>;
}

function Fixture() {
  const fixture = new URLSearchParams(location.search).get("fixture");
  return <main className="min-h-dvh bg-wash p-4 text-fg">
    {fixture === "review" ? <ReviewFixture />
      : fixture === "music" ? <MusicFixture />
      : fixture === "memory" ? <MemoryBoard mode="memory-pairs" />
      : fixture === "pattern" ? <MemoryBoard mode="memory-grid" />
      : fixture === "stack" ? <StackFixture />
      : fixture === "pacman" ? <Pacman /> : <p>Choose a fixture.</p>}
  </main>;
}

const root = document.getElementById("root");
if (import.meta.env.DEV && root) createRoot(root).render(<StrictMode><Fixture /></StrictMode>);

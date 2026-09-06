import { api } from "@code2create/backend/api";
import { mergeSynesthesiaVoteCounts } from "@code2create/domain";
import { useAction, useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useState } from "react";

import type { MusicRequestView, MusicTileModel } from "../components/dashboard/MusicTile";
import { eventSlug } from "./config";
import { useOperationRunner } from "./operations";

type RequestResult = FunctionReturnType<typeof api.synesthesiaYouTube.requestVideo>;

export type MusicRoomModel = MusicTileModel & {
  loaded: boolean;
  report: (request: MusicRequestView, reason: string) => Promise<void>;
  confirmPendingRequest: (() => Promise<{ created: boolean }>) | null;
};

export function useMusicModel(): MusicRoomModel {
  const music = useQuery(api.synesthesiaParticipant.state, { eventSlug });
  const voteCounts = useQuery(api.synesthesiaParticipant.voteCounts, { eventSlug });
  const searchYouTube = useAction(api.synesthesiaYouTube.search);
  const requestVideo = useAction(api.synesthesiaYouTube.requestVideo);
  const addVote = useMutation(api.synesthesiaParticipant.vote);
  const removeVote = useMutation(api.synesthesiaParticipant.removeVote);
  const reportRequest = useMutation(api.synesthesiaParticipant.reportRequest);
  const requests = useOperationRunner<RequestResult>();
  const votes = useOperationRunner();
  const reports = useOperationRunner();
  const [lastRequestSlot, setLastRequestSlot] = useState<string | null>(null);

  const musicWindow = music?.window ?? null;
  const counts =
    voteCounts && musicWindow && voteCounts.windowId === musicWindow.id ? voteCounts.counts : [];
  const views: MusicRequestView[] = music
    ? mergeSynesthesiaVoteCounts(music.requests, counts).map((request) => ({
        id: request.id,
        videoId: request.provider === "youtube" ? request.providerTrackId : null,
        title: request.title,
        artist: request.artist,
        durationSeconds: request.durationSeconds,
        state: request.state,
        voteCount: request.voteCount,
        hasVoted: request.hasVoted,
        canVote: request.canVote,
        isMine: request.isMine,
        canReport: request.canReport,
        hasReported: request.hasReported,
        ...(request.publicReason !== undefined ? { publicReason: request.publicReason } : {}),
        ...(request.playbackStartedAt !== undefined
          ? { playbackStartedAt: request.playbackStartedAt }
          : {}),
      }))
    : [];
  const pendingSlot =
    lastRequestSlot !== null && requests.hasPending(lastRequestSlot) ? lastRequestSlot : null;

  return {
    loaded: music !== undefined,
    eligible: music?.eligible ?? true,
    suspended: music?.suspended ?? false,
    window:
      music && musicWindow
        ? {
            name: musicWindow.name,
            endsAt: musicWindow.endsAt,
            requestsOpen: musicWindow.requestsOpen,
            votingOpen: musicWindow.votingOpen,
            playbackPaused: musicWindow.playbackPaused,
            requestsUsed: music.usage.requests,
            requestsAllowed: musicWindow.maxRequestsPerParticipant,
            votesUsed: music.usage.votes,
            votesAllowed: musicWindow.maxVotesPerParticipant,
          }
        : null,
    nowPlaying: views.find((request) => request.state === "playing") ?? null,
    queue: views.filter((request) => request.state !== "playing"),
    search: (query) => searchYouTube({ eventSlug, query }),
    request: async (video) => {
      if (!musicWindow) throw new Error("No music window is open.");
      const slot = `song-request:${video}`;
      setLastRequestSlot(slot);
      const result = await requests.run(
        slot,
        (clientOperationId) => () =>
          requestVideo({ eventSlug, windowId: musicWindow.id, video, clientOperationId }),
      );
      return { created: result.created };
    },
    toggleVote: async (request) => {
      const source = music?.requests.find((candidate) => candidate.id === request.id);
      if (!source) throw new Error("That request is no longer in the window.");
      await votes.run(
        `song-vote:${source.id}`,
        (clientOperationId) => () =>
          (request.hasVoted ? removeVote : addVote)({
            eventSlug,
            requestId: source.id,
            clientOperationId,
          }),
      );
    },
    report: async (request, reason) => {
      const source = music?.requests.find((candidate) => candidate.id === request.id);
      if (!source) throw new Error("That request is no longer in the window.");
      await reports.run(
        `song-report:${source.id}`,
        (clientOperationId) => () =>
          reportRequest({ eventSlug, requestId: source.id, reason, clientOperationId }),
      );
    },
    confirmPendingRequest: pendingSlot
      ? async () => {
          const result = await requests.retryPending(pendingSlot);
          return { created: result.created };
        }
      : null,
  };
}

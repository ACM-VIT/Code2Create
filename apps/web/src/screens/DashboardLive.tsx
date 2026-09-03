import { api } from '@code2create/backend/api'
import { mergeSynesthesiaVoteCounts, teamRoundStateParticipantLabels } from '@code2create/domain';
import type { FunctionReturnType } from 'convex/server'
import { useAction, useMutation, useQuery } from 'convex/react'
import { useNavigate } from 'react-router-dom'

import type { BenefitsTileModel } from '../components/dashboard/BenefitsTile';
import type { EventTileModel } from '../components/dashboard/EventTile'
import type { HelpTileModel } from '../components/dashboard/HelpTile'
import type { IntegrationsTileModel } from '../components/dashboard/IntegrationsTile'
import type { MusicRequestView, MusicTileModel } from '../components/dashboard/MusicTile'
import type { ReviewTileModel } from '../components/dashboard/ReviewTile'
import type { CheckpointState, UpdatesTileModel } from '../components/dashboard/UpdatesTile'
import type { ClusterMember, ClusterTeam } from '../components/portal/TeamCluster'
import { eventSlug } from '../lib/config';
import { queueWaitName } from '../lib/time';
import { useOperationRunner } from '../lib/operations'
import type { PublicState } from '../types'
import { DashboardScreen } from './DashboardScreen'

type ParticipantCapabilities = FunctionReturnType<typeof api.access.participantCapabilities>
type RequestResult = FunctionReturnType<typeof api.synesthesiaYouTube.requestVideo>
type CheckpointAvailability = FunctionReturnType<typeof api.projectCheckpoints.mine>['checkpoints'][number]['availability']

function checkpointState(availability: CheckpointAvailability): CheckpointState {
  switch (availability) {
    case 'awaiting_confirmation':
      return 'locked'
    case 'upcoming':
    case 'open':
    case 'late':
    case 'closed':
      return availability
    default:
      return 'submitted'
  }
}

function teamsAheadLine(teamsAhead: number | undefined) {
  if (teamsAhead === undefined) return undefined
  if (teamsAhead === 0) return 'You are next. Keep the team nearby.'
  return teamsAhead === 1 ? 'One team ahead of you.' : `${teamsAhead} teams ahead of you.`
}

/** The dashboard wired to the live event. */
export function DashboardLive({
  capabilities,
  event,
  phaseTime,
  discordUrl,
  team,
  members,
  teamEditable,
  onSignOut,
}: {
  capabilities: ParticipantCapabilities
  event: NonNullable<PublicState['event']>
  phaseTime: number
  discordUrl: string | null
  team: ClusterTeam
  members: readonly ClusterMember[]
  teamEditable: boolean
  onSignOut: () => void
}) {
  const navigate = useNavigate()
  const music = useQuery(api.synesthesiaParticipant.state, { eventSlug })
  const voteCounts = useQuery(api.synesthesiaParticipant.voteCounts, { eventSlug })
  const searchYouTube = useAction(api.synesthesiaYouTube.search)
  const requestVideo = useAction(api.synesthesiaYouTube.requestVideo)
  const addVote = useMutation(api.synesthesiaParticipant.vote)
  const removeVote = useMutation(api.synesthesiaParticipant.removeVote)
  const requests = useOperationRunner<RequestResult>()
  const votes = useOperationRunner()
  const integrationsAllowed = capabilities?.integrations ?? false
  const github = useQuery(api.githubIntegrations.current, integrationsAllowed ? { eventSlug } : 'skip')
  const figma = useQuery(api.figmaIntegrations.current, integrationsAllowed ? { eventSlug } : 'skip')
  const checkpointsAllowed = capabilities?.projectCheckpoints ?? false
  const checkpoints = useQuery(api.projectCheckpoints.mine, checkpointsAllowed ? { eventSlug } : 'skip')
  const queueAllowed = capabilities?.reviewQueue ?? false
  const queue = useQuery(api.participantReview.current, queueAllowed ? { eventSlug } : 'skip')
  const mintReviewCode = useMutation(api.participantReview.mintTeamQr);
  const supportAllowed = capabilities?.supportRead ?? false
  const support = useQuery(api.support.mineSummary, supportAllowed ? { eventSlug } : 'skip')
  const benefits = useQuery(api.benefits.mine, { eventSlug });

  const eventModel: EventTileModel = {
    phases: event.phases.map((phase) => ({
      key: phase.phaseKey,
      name: phase.displayName,
      startsAt: phase.startsAt,
      endsAt: phase.endsAt,
    })),
    now: phaseTime,
    timezone: event.timezone,
  }

  const window = music?.window ?? null
  const counts = voteCounts && window && voteCounts.windowId === window.id ? voteCounts.counts : []
  const views: MusicRequestView[] = music
    ? mergeSynesthesiaVoteCounts(music.requests, counts).map((request) => ({
        id: request.id,
        videoId: request.provider === 'youtube' ? request.providerTrackId : null,
        title: request.title,
        artist: request.artist,
        durationSeconds: request.durationSeconds,
        state: request.state,
        voteCount: request.voteCount,
        hasVoted: request.hasVoted,
        canVote: request.canVote,
        isMine: request.isMine,
        ...(request.publicReason !== undefined ? { publicReason: request.publicReason } : {}),
        ...(request.playbackStartedAt !== undefined ? { playbackStartedAt: request.playbackStartedAt } : {}),
      }))
    : []

  const musicModel: MusicTileModel = {
    eligible: music?.eligible ?? true,
    suspended: music?.suspended ?? false,
    window: music && window
      ? {
          name: window.name,
          endsAt: window.endsAt,
          requestsOpen: window.requestsOpen,
          votingOpen: window.votingOpen,
          playbackPaused: window.playbackPaused,
          requestsUsed: music.usage.requests,
          requestsAllowed: window.maxRequestsPerParticipant,
          votesUsed: music.usage.votes,
          votesAllowed: window.maxVotesPerParticipant,
        }
      : null,
    nowPlaying: views.find((request) => request.state === 'playing') ?? null,
    queue: views.filter((request) => request.state !== 'playing'),
    search: (query) => searchYouTube({ eventSlug, query }),
    request: async (video) => {
      if (!window) throw new Error('No music window is open.')
      const result = await requests.run(`song-request:${video}`, (clientOperationId) => () =>
        requestVideo({ eventSlug, windowId: window.id, video, clientOperationId }))
      return { created: result.created }
    },
    toggleVote: async (request) => {
      const source = music?.requests.find((candidate) => candidate.id === request.id)
      if (!source) throw new Error('That request is no longer in the window.')
      await votes.run(`song-vote:${source.id}`, (clientOperationId) => () =>
        (request.hasVoted ? removeVote : addVote)({ eventSlug, requestId: source.id, clientOperationId }))
    },
  }

  const repositoryCount = github?.repositories.length ?? 0
  const fileCount = figma?.summary?.fileCount ?? 0
  const integrationsModel: IntegrationsTileModel = {
    available: integrationsAllowed,
    github: {
      connected: github?.connections.some((connection) => connection.state === 'active') ?? false,
      detail: repositoryCount === 0 ? 'Link your repositories' : repositoryCount === 1 ? '1 repository' : `${repositoryCount} repositories`,
    },
    figma: {
      connected: (figma?.connections.length ?? 0) > 0,
      detail: fileCount === 0 ? 'Link your design files' : fileCount === 1 ? '1 file' : `${fileCount} files`,
    },
    open: () => void navigate('/integrations', { viewTransition: true }),
  }

  const updatesModel: UpdatesTileModel = {
    available: checkpointsAllowed,
    checkpoints: checkpoints?.configured
      ? checkpoints.checkpoints.map((checkpoint) => ({
          key: checkpoint.checkpointKey,
          name: checkpoint.displayName,
          state: checkpointState(checkpoint.availability),
          opensAt: checkpoint.opensAt,
          dueAt: checkpoint.dueAt,
        }))
      : [],
    timezone: event.timezone,
    write: () => void navigate('/updates', { viewTransition: true }),
  }

  const reviewSession = queue?.review ?? null;
  const reviewModel: ReviewTileModel = {
    available: queueAllowed,
    queue: queue
      ? {
          round: queue.round.name,
          state: teamRoundStateParticipantLabels[queue.state],
          detail:
            [
              queue.panel?.name,
              teamsAheadLine(queue.teamsAhead),
              queue.round.isPaused ? "Paused by staff; stay nearby." : undefined,
            ]
              .filter((part): part is string => part !== undefined)
              .join(" · ") || null,
          wait: queue.estimate ? `About ${queueWaitName(queue.estimate, phaseTime)}` : null,
          reviewers: reviewSession
            ? { present: reviewSession.reviewerPresenceCount, total: reviewSession.reviewerCount }
            : null,
        }
      : null,
    showCode:
      reviewSession && reviewSession.canShowTeamQr
        ? {
            sessionId: reviewSession.id,
            mint: async () => {
              const minted = await mintReviewCode({ eventSlug, reviewSessionId: reviewSession.id });
              return {
                payload: minted.payload,
                manualCode: minted.manualCode,
                expiresAt: minted.expiresAt,
                serverNow: minted.serverNow,
              };
            },
          }
        : null,
  };

  const benefitsModel: BenefitsTileModel = {
    available: capabilities?.hasTeamMembership ?? false,
    benefits: benefits ?? [],
  };

  const helpModel: HelpTileModel = {
    discordUrl,
    support: supportAllowed ? { open: support?.openCount ?? 0 } : null,
  }

  return (
    <DashboardScreen
      team={team}
      members={members}
      teamEditable={teamEditable}
      onSignOut={onSignOut}
      event={eventModel}
      music={musicModel}
      integrations={integrationsModel}
      updates={updatesModel}
      review={reviewModel}
      help={helpModel}
      benefits={benefitsModel}
    />
  )
}

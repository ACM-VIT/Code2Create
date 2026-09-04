import { api } from '@code2create/backend/api'
import { mergeSynesthesiaVoteCounts } from '@code2create/domain';
import type { FunctionReturnType } from 'convex/server'
import { useAction, useMutation, useQuery } from 'convex/react'
import { useNavigate } from 'react-router-dom'

import type { BenefitsTileModel } from '../components/dashboard/BenefitsTile';
import type { EventTileModel } from '../components/dashboard/EventTile'
import type { HelpTileModel } from '../components/dashboard/HelpTile'
import type { IntegrationsTileModel } from '../components/dashboard/IntegrationsTile'
import type { MusicRequestView, MusicTileModel } from '../components/dashboard/MusicTile'
import type { ReviewTileModel, ServiceQueueKind } from '../components/dashboard/ReviewTile'
import type { CheckpointState, UpdatesTileModel } from '../components/dashboard/UpdatesTile'
import type { ClusterMember, ClusterTeam } from '../components/portal/TeamCluster'
import { eventSlug } from '../lib/config';
import { useOperationRunner } from '../lib/operations'
import type { AvailableGitHubRepository, PublicState } from '../types'
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
  const listAvailableRepositories = useAction(api.githubActions.listAvailableRepositories)
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
  const serviceQueues = useQuery(api.serviceQueues.current, { eventSlug })
  const joinServiceQueue = useMutation(api.serviceQueues.join)
  const leaveServiceQueue = useMutation(api.serviceQueues.leave)
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

  const connectedRepositories = (github?.repositories ?? [])
    .filter((repository) => repository.state === 'active')
    .map((repository) => ({
      id: repository.id,
      fullName: repository.fullName,
      url: repository.url,
      connectionId: repository.installationConnectionId,
    }))
  const connectedRepositoryIds = new Set(
    (github?.repositories ?? []).map((repository) => repository.repositoryId),
  )
  const activeGithubConnection = github?.connections.find(
    (connection) => connection.state === 'active',
  )
  const fileCount = figma?.summary?.fileCount ?? 0
  const integrationsModel: IntegrationsTileModel = {
    available: integrationsAllowed,
    github: {
      connected: activeGithubConnection !== undefined,
      detail:
        connectedRepositories.length === 0
          ? 'Link your repositories'
          : connectedRepositories.length === 1
            ? '1 repository'
            : `${connectedRepositories.length} repositories`,
      repositories: connectedRepositories,
      ...(activeGithubConnection
        ? {
            listRepositories: async () => {
              const allRepositories: AvailableGitHubRepository[] = []
              let page: number | undefined = 1
              while (page !== undefined) {
                const result = await listAvailableRepositories({
                  eventSlug,
                  connectionId: activeGithubConnection.id,
                  page,
                })
                allRepositories.push(...result.repositories)
                page = result.nextPage
              }
              return allRepositories
                .filter((repository) => !connectedRepositoryIds.has(repository.repositoryId))
                .map((repository) => ({
                  id: repository.repositoryId,
                  fullName: repository.fullName,
                  url: repository.url,
                  connectionId: activeGithubConnection.id,
                  raw: repository,
                }))
            },
          }
        : {}),
    },
    figma: {
      connected: (figma?.connections.length ?? 0) > 0,
      detail:
        fileCount === 0
          ? 'Link your design files'
          : fileCount === 1
            ? '1 file'
            : `${fileCount} files`,
    },
    open: (target, repository) => {
      if (target === 'github' && repository) {
        const isConnected = connectedRepositories.some((r) => r.id === repository.id)
        const connectionId = repository.connectionId ?? activeGithubConnection?.id
        const params = new URLSearchParams()
        if (connectionId) params.set('connectionId', connectionId)
        if (isConnected) {
          params.set('archiveId', repository.id)
        } else {
          params.set('repositoryId', repository.id)
        }
        void navigate(
          {
            pathname: '/integrations',
            search: `?${params.toString()}`,
          },
          {
            state: {
              connectionId,
              repositoryId: isConnected ? undefined : repository.id,
              archiveId: isConnected ? repository.id : undefined,
              repository: repository.raw,
            },
            viewTransition: true,
          },
        )
        return
      }
      void navigate('/integrations', { viewTransition: true })
    },
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
    available: queueAllowed || serviceQueues !== undefined,
    queue: queue
      ? {
          round: queue.round.name,
          rank: queue.teamsAhead === undefined ? null : queue.teamsAhead + 1,
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
    services: (serviceQueues ?? []).map((service) => ({
      kind: service.kind,
      joined: service.joined,
      position: service.position,
      waitingCount: service.waitingCount,
    })),
    setServiceQueue: async (kind: ServiceQueueKind, joined: boolean) => {
      if (joined) await joinServiceQueue({ eventSlug, kind })
      else await leaveServiceQueue({ eventSlug, kind })
    },
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

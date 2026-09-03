import { api } from '@code2create/backend/api'
import { mergeSynesthesiaVoteCounts } from '@code2create/domain'
import type { FunctionReturnType } from 'convex/server'
import { useAction, useMutation, useQuery } from 'convex/react'
import { useNavigate } from 'react-router-dom'

import type { IntegrationsTileModel } from '../components/dashboard/IntegrationsTile'
import type { MusicRequestView, MusicTileModel } from '../components/dashboard/MusicTile'
import type { ClusterMember, ClusterTeam } from '../components/portal/TeamCluster'
import { eventSlug } from '../lib/config'
import { useOperationRunner } from '../lib/operations'
import { DashboardScreen } from './DashboardScreen'

type ParticipantCapabilities = FunctionReturnType<typeof api.access.participantCapabilities>
type RequestResult = FunctionReturnType<typeof api.synesthesiaYouTube.requestVideo>

/** The dashboard wired to the live event: music and tools from Convex. */
export function DashboardLive({
  capabilities,
  team,
  members,
  teamEditable,
  onSignOut,
}: {
  capabilities: ParticipantCapabilities
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

  return (
    <DashboardScreen
      team={team}
      members={members}
      teamEditable={teamEditable}
      onSignOut={onSignOut}
      music={musicModel}
      integrations={integrationsModel}
    />
  )
}

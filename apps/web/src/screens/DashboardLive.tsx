import { api } from "@code2create/backend/api";
import type { FunctionReturnType } from "convex/server";
import { useMutation, useQuery } from "convex/react";
import { useNavigate } from "react-router-dom";

import type { BenefitsTileModel } from "../components/dashboard/BenefitsTile";
import type { EventTileModel } from "../components/dashboard/EventTile";
import type { HelpTileModel } from "../components/dashboard/HelpTile";
import type { IntegrationsTileModel } from "../components/dashboard/IntegrationsTile";
import type { ReviewTileModel } from "../components/dashboard/ReviewTile";
import type { ServiceQueuesTileModel } from "../components/dashboard/ServiceQueuesTile";
import type {
  CheckpointState,
  UpdatesTileModel,
} from "../components/dashboard/UpdatesTile";
import { DelayedBonsai } from "../components/portal/DelayedBonsai";
import { PortalScene } from "../components/portal/PortalScene";
import {
  TeamCluster,
  type ClusterMember,
  type ClusterTeam,
} from "../components/portal/TeamCluster";
import { eventSlug } from "../lib/config";
import { useOperationRunner } from "../lib/operations";
import { LiveNumber } from "../components/LiveNumber";
import { useMusicModel } from "../lib/useMusicModel";
import type { PublicState } from "../types";
import { DashboardScreen } from "./DashboardScreen";

type ParticipantCapabilities = FunctionReturnType<typeof api.access.participantCapabilities>;
type CheckpointAvailability = FunctionReturnType<typeof api.projectCheckpoints.mine>["checkpoints"][number]["availability"];

function checkpointState(
  availability: CheckpointAvailability,
): CheckpointState {
  switch (availability) {
    case "awaiting_confirmation":
      return "locked";
    case "upcoming":
    case "open":
    case "late":
    case "closed":
      return availability;
    default:
      return "submitted";
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
  capabilities: ParticipantCapabilities;
  event: NonNullable<PublicState["event"]>;
  phaseTime: number;
  discordUrl: string | null;
  team: ClusterTeam;
  members: readonly ClusterMember[];
  teamEditable: boolean;
  onSignOut: () => void;
}) {
  const navigate = useNavigate();
  const musicModel = useMusicModel();
  const integrationsAllowed = capabilities?.integrations ?? false;
  const github = useQuery(api.githubIntegrations.current, integrationsAllowed ? { eventSlug } : "skip",
  );
  const figma = useQuery(api.figmaLinks.current, integrationsAllowed ? { eventSlug } : "skip",
  );
  const checkpointsAllowed = capabilities?.projectCheckpoints ?? false;
  const checkpoints = useQuery(api.projectCheckpoints.mine, checkpointsAllowed ? { eventSlug } : "skip",
  );
  const queueAllowed = capabilities?.reviewQueue ?? false;
  const queue = useQuery(api.participantReview.current, queueAllowed ? { eventSlug } : "skip",
  );
  const mintReviewCode = useMutation(api.participantReview.mintTeamQr);
  const serviceQueueWindows = useQuery(api.serviceQueues.current, { eventSlug });
  const serviceQueues = serviceQueueWindows?.filter(queue => (phaseTime >= queue.opensAt && phaseTime < queue.closesAt) || ["out", "overdue"].includes(queue.status));
  const outingOperations = useOperationRunner<null>();
  const joinServiceQueue = useMutation(api.serviceQueues.join);
  const leaveServiceQueue = useMutation(api.serviceQueues.leave);
  const supportAllowed = capabilities?.supportRead ?? false;
  const support = useQuery(api.support.mineSummary, supportAllowed ? { eventSlug } : "skip");
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
  };

  const connectedRepositories = (github?.repositories ?? [])
    .filter((repository) => repository.state === "active")
    .map((repository) => ({
      id: repository.id,
      fullName: repository.fullName,
      url: repository.url,
      connectionId: repository.installationConnectionId,
    }));
  const activeGithubConnection = github?.connections.find(
    (connection) => connection.state === "active",
  );
  const integrationsModel: IntegrationsTileModel = {
    available: integrationsAllowed,
    github: {
      connected: activeGithubConnection !== undefined,
      detail:
        connectedRepositories.length === 0
          ? "Link your repositories"
          : connectedRepositories.length === 1
            ? "1 repository"
            : <><LiveNumber value={connectedRepositories.length} /> repositories</>,
      repositories: connectedRepositories,
    },
    figma: {
      connected: Boolean(figma?.fileUrl),
      detail: figma?.fileUrl ? "Design link added" : "Add your design link",
    },
    open: (target, repository) => {
      if (target === "github" && repository) {
        const isConnected = connectedRepositories.some((r) => r.id === repository.id,
        );
        const connectionId = repository.connectionId ?? activeGithubConnection?.id;
        const params = new URLSearchParams();
        if (connectionId) params.set("connectionId", connectionId);
        if (isConnected) {
          params.set("archiveId", repository.id);
        } else {
          params.set("repositoryId", repository.id);
        }
        void navigate(
          {
            pathname: "/integrations",
            search: `?${params.toString()}`,
          },
          {
            state: {
              connectionId,
              repositoryId: isConnected ? undefined : repository.id,
              archiveId: isConnected ? repository.id : undefined,
            },
            viewTransition: true,
          },
        );
        return;
      }
      void navigate("/integrations", { viewTransition: true });
    },
  };

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
    write: () => void navigate("/updates", { viewTransition: true }),
  };

  const reviewSession = queue?.review ?? null;
  const reviewModel: ReviewTileModel | null = queue ? {
    round: queue.round.name,
    state: queue.state,
    paused: queue.round.isPaused,
    upNext: queue.notice?.kind === "up_next",
    panel: queue.panel?.name ?? null,
    rank: queue.teamsAhead === undefined ? null : queue.teamsAhead + 1,
    notice: queue.notice?.message ?? null,
    estimate: queue.estimate,
    now: phaseTime,
    session: reviewSession ? {
      status: reviewSession.status,
      present: reviewSession.reviewerPresenceCount,
      total: reviewSession.reviewerCount,
    } : null,
    showCode:
      reviewSession && reviewSession.canShowTeamQr
        ? {
            sessionId: reviewSession.id,
            mint: async () => {
              const minted = await mintReviewCode({ eventSlug, reviewSessionId: reviewSession.id,
              });
              return {
                payload: minted.payload,
                manualCode: minted.manualCode,
                expiresAt: minted.expiresAt,
                serverNow: minted.serverNow,
              };
            },
          }
        : null,
  } : null;

  const queuesModel: ServiceQueuesTileModel = {
    available: serviceQueues !== undefined,
    pending: outingOperations.hasPending("outing"),
    services: serviceQueues ?? [],
    setServiceQueue: async (kind, joined) => {
      await outingOperations.run("outing", (clientOperationId) => {
        if (joined) return () => joinServiceQueue({ eventSlug, kind, clientOperationId });
        const requestId = serviceQueues?.find((service) => service.kind === kind)?.requestId;
        if (!requestId) throw new Error("This outing request has already changed.");
        return () => leaveServiceQueue({ eventSlug, requestId, clientOperationId });
      });
    },
  };

  const benefitsModel: BenefitsTileModel = {
    available: capabilities?.hasTeamMembership ?? false,
    benefits: benefits ?? [],
  };

  const helpModel: HelpTileModel = {
    discordUrl,
    support: supportAllowed ? { open: support?.openCount ?? 0 } : null,
  };

  // Seat the bento once the first snapshots are in. Seating it on defaults
  // and again a moment later would shuffle the grid under the reader.
  const ready =
    musicModel.loaded &&
    serviceQueues !== undefined &&
    benefits !== undefined &&
    (!integrationsAllowed || (github !== undefined && figma !== undefined)) &&
    (!checkpointsAllowed || checkpoints !== undefined) &&
    (!queueAllowed || queue !== undefined) &&
    (!supportAllowed || support !== undefined);
  if (!ready) {
    return (
      <PortalScene
        tree="both"
        onSignOut={onSignOut}
        header={<TeamCluster team={team} members={members} editable={teamEditable} />}
      >
        <DelayedBonsai />
      </PortalScene>
    );
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
      queues={queuesModel}
      help={helpModel}
      benefits={benefitsModel}
    />
  );
}

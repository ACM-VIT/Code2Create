import type { BenefitsTileModel } from "./BenefitsTile";
import type { EventTileModel } from "./EventTile";
import type { HelpTileModel } from "./HelpTile";
import type { IntegrationsTileModel } from "./IntegrationsTile";
import type { MusicTileModel } from "./MusicTile";
import type { ReviewTileModel } from "./ReviewTile";
import type { ServiceQueuesTileModel } from "./ServiceQueuesTile";
import type { UpdatesTileModel } from "./UpdatesTile";
import type { Candidate } from "./dashboardLayout";

export type DashboardModels = {
  event: EventTileModel;
  music: MusicTileModel;
  integrations: IntegrationsTileModel;
  updates: UpdatesTileModel;
  review: ReviewTileModel | null;
  queues: ServiceQueuesTileModel;
  help: HelpTileModel;
  benefits: BenefitsTileModel;
};

/**
 * How much each tile matters right now, 0 to 100. The seven highest are
 * shown; a tile with nothing to say (no review round, no perks) scores low
 * and gives its slot to one that has.
 */
export function tileRelevance(models: DashboardModels): Candidate[] {
  const { event, music, integrations, updates, review, queues, help, benefits } = models;
  const now = event.now;
  const nextBoundary = event.phases
    .flatMap((phase) => [phase.startsAt, phase.endsAt])
    .filter((time) => time > now)
    .sort((left, right) => left - right)[0];
  const boundarySoon = nextBoundary !== undefined && nextBoundary - now < 60 * 60_000;
  const musicScore = !music.eligible ? 5 : music.window === null ? 20 : music.nowPlaying ? 88 : 80;
  const bothConnected = integrations.github.connected && integrations.figma.connected;
  const openCheckpoint = updates.checkpoints.some((checkpoint) => checkpoint.state === "open" || checkpoint.state === "late");
  const upcomingCheckpoint = updates.checkpoints.some((checkpoint) => checkpoint.state === "upcoming");
  const reviewIsActive = review !== null && ["queued", "called", "at_table", "in_review", "held", "missed"].includes(review.state);
  const reviewScore = reviewIsActive ? 98 : review?.state === "completed" ? 40 : 0;
  const queuesScore = queues.services.some((service) => service.joined) ? 85 : queues.services.length > 0 ? 68 : 0;
  return [
    { key: "event", score: boundarySoon ? 95 : 90, prefer: ["wide", "box"] },
    { key: "music", score: musicScore, prefer: ["tall", "wide"] },
    { key: "squad", score: 45, prefer: ["box", "tall"] },
    { key: "integrations", score: !integrations.available ? 10 : bothConnected ? 30 : 60, prefer: ["box", "wide"] },
    { key: "updates", score: !updates.available ? 10 : openCheckpoint ? 92 : upcomingCheckpoint ? 55 : 15, prefer: ["tall", "box"] },
    ...(reviewScore > 0 ? [{ key: "review" as const, score: reviewScore, prefer: ["wide", "box"] as const }] : []),
    { key: "queues", score: queuesScore, prefer: ["box", "tall"] },
    { key: "help", score: help.support && help.support.open > 0 ? 50 : 35, prefer: ["box", "wide"] },
    { key: "benefits", score: !benefits.available ? 5 : benefits.benefits.length > 0 ? 70 : 8, prefer: ["box", "tall"] },
  ];
}

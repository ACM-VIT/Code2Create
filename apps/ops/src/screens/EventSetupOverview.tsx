import { api } from "@code2create/backend/api";
import { useQuery } from "convex/react";
import { Link } from "react-router-dom";

import {
  ConfigurationTabs,
  type ConfigurationTabsVisibility,
} from "../components/ConfigurationTabs";
import { EventLifecycleControl } from "../components/EventLifecycleControl";
import { eventSlug } from "../lib/config";

type SetupState = "attention" | "draft" | "loading" | "ready";

type SetupRowProps = {
  detail: string;
  label: string;
  state: SetupState;
  status: string;
  to: string;
};

export function EventSetupOverview({ tabs }: { tabs: ConfigurationTabsVisibility }) {
  const participants = useQuery(
    api.participantPolicyConfiguration.current,
    tabs.showParticipants ? { eventSlug } : "skip",
  );
  const intake = useQuery(
    api.intakePolicyConfiguration.current,
    tabs.showIntake ? { eventSlug } : "skip",
  );
  const novelty = useQuery(
    api.noveltyConfiguration.current,
    tabs.showNovelty ? { eventSlug } : "skip",
  );
  const admissions = useQuery(
    api.admissionPolicyConfiguration.current,
    tabs.showAdmissions ? { eventSlug } : "skip",
  );
  const communications = useQuery(
    api.communicationsPolicyConfiguration.current,
    tabs.showCommunications ? { eventSlug } : "skip",
  );
  const integrations = useQuery(
    api.integrationPolicyConfiguration.current,
    tabs.showIntegrations ? { eventSlug } : "skip",
  );
  const phases = useQuery(api.phaseConfiguration.current, tabs.showPhases ? { eventSlug } : "skip");
  const checkpoints = useQuery(
    api.checkpointConfiguration.current,
    tabs.showCheckpoints ? { eventSlug } : "skip",
  );
  const intelligence = useQuery(
    api.operationsAutonomyPolicyConfiguration.current,
    tabs.showIntelligence ? { eventSlug } : "skip",
  );
  const attendance = useQuery(
    api.attendanceConfiguration.current,
    tabs.showAttendance ? { eventSlug } : "skip",
  );

  return (
    <section className="setup-home">
      <ConfigurationTabs visibility={tabs} />
      <header className="setup-heading">
        <p className="eyebrow">Code2Create 7.0</p>
        <h1>Event setup</h1>
        <p className="muted">Configure what participants see and what staff run.</p>
      </header>

      {tabs.showLifecycle ? (
        <SetupSection title="Event state">
          <EventLifecycleControl />
        </SetupSection>
      ) : null}

      {tabs.showParticipants || tabs.showIntake || tabs.showNovelty || tabs.showAdmissions ? (
        <SetupSection title="Applications">
          {tabs.showParticipants ? (
            <SetupRow
              detail={
                participants
                  ? `Teams of ${participants.publishedPolicy.policy.teamMinimumSize}–${participants.publishedPolicy.policy.teamMaximumSize} · VIT and external teams stay separate`
                  : "Loading the participant form…"
              }
              label="Participant form"
              state={publishedState(participants, Boolean(participants?.draftPolicy))}
              status={publishedStatus(participants, Boolean(participants?.draftPolicy))}
              to="/configuration/participants"
            />
          ) : null}
          {tabs.showIntake ? (
            <SetupRow
              detail={
                intake
                  ? "Two fixed questions, then up to two useful follow-ups"
                  : "Loading the idea questions…"
              }
              label="Idea questions"
              state={publishedState(intake, Boolean(intake?.draftPolicy))}
              status={publishedStatus(intake, Boolean(intake?.draftPolicy))}
              to="/configuration/intake"
            />
          ) : null}
          {tabs.showNovelty ? (
            <SetupRow
              detail={
                novelty
                  ? novelty.publishedCorpus
                    ? `${novelty.publishedCorpus.entryCount} reviewed projects in the comparison set`
                    : "No comparison set is visible to participants"
                  : "Loading idea comparison…"
              }
              label="Idea originality"
              state={noveltyState(novelty)}
              status={noveltyStatus(novelty)}
              to="/configuration/novelty"
            />
          ) : null}
          {tabs.showAdmissions ? (
            <SetupRow
              detail={
                admissions
                  ? `${admissions.publishedRelease.configuration.minimumHumanReviews} human review${admissions.publishedRelease.configuration.minimumHumanReviews === 1 ? "" : "s"} · ${admissions.publishedRelease.configuration.overallParticipantCapacity} participant places`
                  : "Loading admissions…"
              }
              label="Admissions"
              state={publishedState(admissions, Boolean(admissions?.draftRelease))}
              status={
                admissions?.publicationLocked
                  ? "Locked for this cycle"
                  : publishedStatus(admissions, Boolean(admissions?.draftRelease))
              }
              to="/configuration/admissions"
            />
          ) : null}
        </SetupSection>
      ) : null}

      {tabs.showCommunications || tabs.showPhases || tabs.showCheckpoints ? (
        <SetupSection title="Participant experience">
          {tabs.showCommunications ? (
            <SetupRow
              detail={
                communications
                  ? `${communications.publishedPolicy.policy.venueName} · ${communications.publishedPolicy.policy.emailTemplates.length} email templates`
                  : "Loading participant communications…"
              }
              label="Accepted teams"
              state={publishedState(communications, Boolean(communications?.draftPolicy))}
              status={publishedStatus(communications, Boolean(communications?.draftPolicy))}
              to="/configuration/communications"
            />
          ) : null}
          {tabs.showPhases ? (
            <SetupRow
              detail={
                phases
                  ? phases.publishedSchedule
                    ? `${phases.publishedSchedule.phases.length} participant-visible phases · ${phases.timezone}`
                    : `No participant schedule is published · ${phases.timezone}`
                  : "Loading the event schedule…"
              }
              label="Schedule"
              state={optionalPublicationState(
                phases,
                Boolean(phases?.publishedSchedule),
                Boolean(phases?.draftSchedule),
              )}
              status={optionalPublicationStatus(
                phases,
                Boolean(phases?.publishedSchedule),
                Boolean(phases?.draftSchedule),
              )}
              to="/configuration/phases"
            />
          ) : null}
          {tabs.showCheckpoints ? (
            <SetupRow
              detail={
                checkpoints
                  ? checkpoints.publishedPlan
                    ? `${checkpoints.publishedPlan.definitions.length} participant update prompts`
                    : "No team update prompts are published"
                  : "Loading team updates…"
              }
              label="Team updates"
              state={checkpointState(checkpoints)}
              status={checkpointStatus(checkpoints)}
              to="/configuration/checkpoints"
            />
          ) : null}
        </SetupSection>
      ) : null}

      {tabs.showAttendance || tabs.showIntegrations ? (
        <SetupSection title="Event day">
          {tabs.showAttendance ? (
            <SetupRow
              detail={
                attendance
                  ? attendance.publishedPlan
                    ? attendance.publishedPlan.name
                    : "No check-in plan is published"
                  : "Loading the check-in plan…"
              }
              label="Check-in plan"
              state={optionalPublicationState(
                attendance,
                Boolean(attendance?.publishedPlan),
                Boolean(attendance?.draftPlan),
              )}
              status={optionalPublicationStatus(
                attendance,
                Boolean(attendance?.publishedPlan),
                Boolean(attendance?.draftPlan),
              )}
              to="/attendance-setup"
            />
          ) : null}
          {tabs.showIntegrations ? (
            <SetupRow
              detail={
                integrations
                  ? `${integrations.publishedPolicy.policy.requiredGitHubTopic} · ${integrations.publishedPolicy.policy.maxActiveGitHubRepositoriesPerTeam} GitHub · ${integrations.publishedPolicy.policy.maxActiveFigmaFilesPerTeam} Figma per team`
                  : "Loading the code and design policy…"
              }
              label="Code and design"
              state={publishedState(integrations, Boolean(integrations?.draftPolicy))}
              status={publishedStatus(integrations, Boolean(integrations?.draftPolicy))}
              to="/configuration/integrations"
            />
          ) : null}
        </SetupSection>
      ) : null}

      {tabs.showIntelligence ? (
        <SetupSection title="Operations">
          <SetupRow
            detail={
              intelligence
                ? intelligence.scheduler.lifecycle.kind === "active"
                  ? `${humanizeAutonomyMode(intelligence.publishedPolicy.policy.mode)} · checks every ${intelligence.publishedPolicy.policy.scheduleIntervalMinutes} min`
                  : "Agent monitoring is stopped"
                : "Loading the operations agent…"
            }
            label="Operations agent"
            state={publishedState(intelligence, Boolean(intelligence?.draftPolicy))}
            status={
              intelligence
                ? intelligence.draftPolicy
                  ? "Finish draft"
                  : intelligence.scheduler.lifecycle.kind === "active"
                    ? "Running"
                    : "Off"
                : "Loading"
            }
            to="/configuration/intelligence"
          />
        </SetupSection>
      ) : null}
    </section>
  );
}

function humanizeAutonomyMode(mode: "observe" | "recommend") {
  return mode === "observe" ? "Observe only" : "Observe and recommend";
}

function SetupSection({ children, title }: { children: React.ReactNode; title: string }) {
  return (
    <section className="setup-section">
      <h2>{title}</h2>
      <div className="setup-list">{children}</div>
    </section>
  );
}

function SetupRow({ detail, label, state, status, to }: SetupRowProps) {
  return (
    <Link className="setup-row" to={to}>
      <span>
        <strong>{label}</strong>
        <small>{detail}</small>
      </span>
      <span className={`setup-state ${state}`}>{status}</span>
      <span aria-hidden="true">→</span>
    </Link>
  );
}

function publishedState(value: object | undefined, hasDraft: boolean): SetupState {
  if (value === undefined) return "loading";
  return hasDraft ? "draft" : "ready";
}

function publishedStatus(value: object | undefined, hasDraft: boolean) {
  if (value === undefined) return "Loading";
  return hasDraft ? "Finish draft" : "Ready";
}

function optionalPublicationState(
  value: object | undefined,
  hasPublished: boolean,
  hasDraft: boolean,
): SetupState {
  if (value === undefined) return "loading";
  if (hasDraft) return "draft";
  return hasPublished ? "ready" : "attention";
}

function optionalPublicationStatus(
  value: object | undefined,
  hasPublished: boolean,
  hasDraft: boolean,
) {
  if (value === undefined) return "Loading";
  if (hasDraft) return "Finish draft";
  return hasPublished ? "Ready" : "Set up";
}

function noveltyState(
  value: ReturnType<typeof useQuery<typeof api.noveltyConfiguration.current>>,
): SetupState {
  if (value === undefined) return "loading";
  if (value.draftCorpus) return "draft";
  if (!value.publishedCorpus || !value.providerConfigured) return "attention";
  return "ready";
}

function noveltyStatus(
  value: ReturnType<typeof useQuery<typeof api.noveltyConfiguration.current>>,
) {
  if (value === undefined) return "Loading";
  if (value.draftCorpus) return "Finish draft";
  if (!value.publishedCorpus) return "Set up";
  return value.providerConfigured ? "Ready" : "Connection needed";
}

function checkpointState(
  value: ReturnType<typeof useQuery<typeof api.checkpointConfiguration.current>>,
): SetupState {
  if (value === undefined) return "loading";
  if (value.draftPlan) return "draft";
  if (!value.publishedPlan || !value.hasPublishedPhaseSchedule) return "attention";
  return "ready";
}

function checkpointStatus(
  value: ReturnType<typeof useQuery<typeof api.checkpointConfiguration.current>>,
) {
  if (value === undefined) return "Loading";
  if (value.draftPlan) return "Finish draft";
  if (!value.hasPublishedPhaseSchedule) return "Publish schedule first";
  return value.publishedPlan ? "Ready" : "Set up";
}

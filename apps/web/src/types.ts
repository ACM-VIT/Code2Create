import { api } from "@code2create/backend/api";
import type { FunctionReturnType } from "convex/server";

export type PublicState = FunctionReturnType<typeof api.system.getPublicState>;
export type ParticipantMe = NonNullable<FunctionReturnType<typeof api.participants.me>>;
export type CurrentTeam = NonNullable<FunctionReturnType<typeof api.teams.current>>;
export type CurrentTeamMember = FunctionReturnType<typeof api.teams.members>["page"][number];
export type CurrentIntake = NonNullable<FunctionReturnType<typeof api.intake.current>>;
export type SubmittedIntake = NonNullable<FunctionReturnType<typeof api.intake.submitted>>;
export type CurrentGitHubIntegration = NonNullable<
  FunctionReturnType<typeof api.githubIntegrations.current>
>;
export type AvailableGitHubRepository = FunctionReturnType<
  typeof api.githubActions.listAvailableRepositories
>["repositories"][number];
export type GitHubConnectionResult = FunctionReturnType<
  typeof api.githubActions.completeConnection
>;
export type GitHubStarGateState = NonNullable<
  FunctionReturnType<typeof api.githubStarGate.current>
>;
export type GitHubStarConnectionResult = FunctionReturnType<
  typeof api.githubStarActions.completeConnection
>;
export type CurrentFigmaIntegration = NonNullable<
  FunctionReturnType<typeof api.figmaIntegrations.current>
>;
export type FigmaConnectionResult = FunctionReturnType<typeof api.figmaActions.completeConnection>;
export type SubmissionPreview = NonNullable<
  FunctionReturnType<typeof api.intake.submissionPreview>
>;

export type SupportCaseSummary = FunctionReturnType<typeof api.support.mine>[number];
export type SupportCaseDetail = NonNullable<FunctionReturnType<typeof api.support.detail>>;

export type ParticipantClass = "vit_student" | "external_participant";

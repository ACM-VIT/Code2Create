/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as access from "../access.js";
import type * as accessInvitations from "../accessInvitations.js";
import type * as accessRoles from "../accessRoles.js";
import type * as accessSubjects from "../accessSubjects.js";
import type * as admissionIntelligence from "../admissionIntelligence.js";
import type * as admissionPolicyConfiguration from "../admissionPolicyConfiguration.js";
import type * as admissions from "../admissions.js";
import type * as attendanceActions from "../attendanceActions.js";
import type * as attendanceConfiguration from "../attendanceConfiguration.js";
import type * as attendanceCredentials from "../attendanceCredentials.js";
import type * as attendanceExportActions from "../attendanceExportActions.js";
import type * as attendanceExports from "../attendanceExports.js";
import type * as attendanceManualSheetActions from "../attendanceManualSheetActions.js";
import type * as attendanceManualSheets from "../attendanceManualSheets.js";
import type * as attendanceOperations from "../attendanceOperations.js";
import type * as attendanceParticipant from "../attendanceParticipant.js";
import type * as attendancePortalQr from "../attendancePortalQr.js";
import type * as attendanceReconciliation from "../attendanceReconciliation.js";
import type * as attendanceRemedies from "../attendanceRemedies.js";
import type * as attendanceRollCalls from "../attendanceRollCalls.js";
import type * as attendanceScan from "../attendanceScan.js";
import type * as attendanceScanner from "../attendanceScanner.js";
import type * as attendanceSecurity from "../attendanceSecurity.js";
import type * as attendanceSessions from "../attendanceSessions.js";
import type * as attendanceVenueCheckIns from "../attendanceVenueCheckIns.js";
import type * as auth from "../auth.js";
import type * as checkpointConfiguration from "../checkpointConfiguration.js";
import type * as communicationsPolicyConfiguration from "../communicationsPolicyConfiguration.js";
import type * as crons from "../crons.js";
import type * as emergencyPackActions from "../emergencyPackActions.js";
import type * as emergencyPacks from "../emergencyPacks.js";
import type * as eventLifecycle from "../eventLifecycle.js";
import type * as figmaActions from "../figmaActions.js";
import type * as figmaIntegrations from "../figmaIntegrations.js";
import type * as figmaWebhook from "../figmaWebhook.js";
import type * as floorConfiguration from "../floorConfiguration.js";
import type * as floorMapping from "../floorMapping.js";
import type * as floorOperations from "../floorOperations.js";
import type * as floorParticipant from "../floorParticipant.js";
import type * as generatedHandbook from "../generatedHandbook.js";
import type * as githubActions from "../githubActions.js";
import type * as githubIntegrations from "../githubIntegrations.js";
import type * as githubWebhook from "../githubWebhook.js";
import type * as handbook from "../handbook.js";
import type * as http from "../http.js";
import type * as identityClaims from "../identityClaims.js";
import type * as incidents from "../incidents.js";
import type * as intake from "../intake.js";
import type * as intakeConfiguration from "../intakeConfiguration.js";
import type * as intakePolicyConfiguration from "../intakePolicyConfiguration.js";
import type * as integrationOperations from "../integrationOperations.js";
import type * as intelligence from "../intelligence.js";
import type * as lib_accessVersion from "../lib/accessVersion.js";
import type * as lib_admission from "../lib/admission.js";
import type * as lib_admissionPolicy from "../lib/admissionPolicy.js";
import type * as lib_admissionRecommendation from "../lib/admissionRecommendation.js";
import type * as lib_artifactStorage from "../lib/artifactStorage.js";
import type * as lib_attendance from "../lib/attendance.js";
import type * as lib_attendanceCounters from "../lib/attendanceCounters.js";
import type * as lib_attendanceCredentialLifecycle from "../lib/attendanceCredentialLifecycle.js";
import type * as lib_attendanceOfflineReplay from "../lib/attendanceOfflineReplay.js";
import type * as lib_attendancePlan from "../lib/attendancePlan.js";
import type * as lib_attendancePortalQrLifecycle from "../lib/attendancePortalQrLifecycle.js";
import type * as lib_attendanceRollCalls from "../lib/attendanceRollCalls.js";
import type * as lib_attendanceSessionLifecycle from "../lib/attendanceSessionLifecycle.js";
import type * as lib_attendanceSessionTransition from "../lib/attendanceSessionTransition.js";
import type * as lib_attendanceStations from "../lib/attendanceStations.js";
import type * as lib_attendanceTeamAvailability from "../lib/attendanceTeamAvailability.js";
import type * as lib_audit from "../lib/audit.js";
import type * as lib_cloudflareEmailSending from "../lib/cloudflareEmailSending.js";
import type * as lib_communicationsPolicy from "../lib/communicationsPolicy.js";
import type * as lib_csv from "../lib/csv.js";
import type * as lib_emergencyPack from "../lib/emergencyPack.js";
import type * as lib_eventLifecycle from "../lib/eventLifecycle.js";
import type * as lib_events from "../lib/events.js";
import type * as lib_figmaCheckpointComparison from "../lib/figmaCheckpointComparison.js";
import type * as lib_figmaEvidenceBrowser from "../lib/figmaEvidenceBrowser.js";
import type * as lib_figmaMetadataSchedule from "../lib/figmaMetadataSchedule.js";
import type * as lib_figmaTeamMetrics from "../lib/figmaTeamMetrics.js";
import type * as lib_floor from "../lib/floor.js";
import type * as lib_githubClient from "../lib/githubClient.js";
import type * as lib_githubTeamMetrics from "../lib/githubTeamMetrics.js";
import type * as lib_grantScopes from "../lib/grantScopes.js";
import type * as lib_identity from "../lib/identity.js";
import type * as lib_intakePolicy from "../lib/intakePolicy.js";
import type * as lib_intakeQuestions from "../lib/intakeQuestions.js";
import type * as lib_localBrowserFixtures from "../lib/localBrowserFixtures.js";
import type * as lib_novelty from "../lib/novelty.js";
import type * as lib_operations from "../lib/operations.js";
import type * as lib_operationsHealth from "../lib/operationsHealth.js";
import type * as lib_operationsIntelligencePolicy from "../lib/operationsIntelligencePolicy.js";
import type * as lib_operationsIntelligenceValidators from "../lib/operationsIntelligenceValidators.js";
import type * as lib_participantNotificationDelivery from "../lib/participantNotificationDelivery.js";
import type * as lib_participantPolicy from "../lib/participantPolicy.js";
import type * as lib_permissionBundleEntries from "../lib/permissionBundleEntries.js";
import type * as lib_permissionCatalog from "../lib/permissionCatalog.js";
import type * as lib_permissionDelegation from "../lib/permissionDelegation.js";
import type * as lib_permissionGrantLifecycle from "../lib/permissionGrantLifecycle.js";
import type * as lib_permissions from "../lib/permissions.js";
import type * as lib_phaseSchedule from "../lib/phaseSchedule.js";
import type * as lib_projectCheckpointPlan from "../lib/projectCheckpointPlan.js";
import type * as lib_projectText from "../lib/projectText.js";
import type * as lib_providerSecrets from "../lib/providerSecrets.js";
import type * as lib_pushTokens from "../lib/pushTokens.js";
import type * as lib_queueEstimate from "../lib/queueEstimate.js";
import type * as lib_rehearsal from "../lib/rehearsal.js";
import type * as lib_reviewAccess from "../lib/reviewAccess.js";
import type * as lib_reviewParticipantAvailability from "../lib/reviewParticipantAvailability.js";
import type * as lib_reviewRoundPauses from "../lib/reviewRoundPauses.js";
import type * as lib_reviewScores from "../lib/reviewScores.js";
import type * as lib_roundExportFormat from "../lib/roundExportFormat.js";
import type * as lib_staffedParticipantResolution from "../lib/staffedParticipantResolution.js";
import type * as lib_strings from "../lib/strings.js";
import type * as lib_supportCases from "../lib/supportCases.js";
import type * as lib_synesthesia from "../lib/synesthesia.js";
import type * as lib_trackCatalog from "../lib/trackCatalog.js";
import type * as lib_venueCheckInLifecycle from "../lib/venueCheckInLifecycle.js";
import type * as localDevelopment from "../localDevelopment.js";
import type * as manualReviewRecordActions from "../manualReviewRecordActions.js";
import type * as manualReviewRecords from "../manualReviewRecords.js";
import type * as novelty from "../novelty.js";
import type * as noveltyConfiguration from "../noveltyConfiguration.js";
import type * as operationsHealth from "../operationsHealth.js";
import type * as operationsIntelligence from "../operationsIntelligence.js";
import type * as operationsIntelligenceActions from "../operationsIntelligenceActions.js";
import type * as operationsIntelligenceAutomation from "../operationsIntelligenceAutomation.js";
import type * as operationsIntelligencePolicyConfiguration from "../operationsIntelligencePolicyConfiguration.js";
import type * as operationsIntelligenceWebhook from "../operationsIntelligenceWebhook.js";
import type * as participantCommunications from "../participantCommunications.js";
import type * as participantEmail from "../participantEmail.js";
import type * as participantEmailEvent from "../participantEmailEvent.js";
import type * as participantNotificationState from "../participantNotificationState.js";
import type * as participantNotifications from "../participantNotifications.js";
import type * as participantPolicyConfiguration from "../participantPolicyConfiguration.js";
import type * as participantReview from "../participantReview.js";
import type * as participants from "../participants.js";
import type * as permissionBundleMigrations from "../permissionBundleMigrations.js";
import type * as permissionBundles from "../permissionBundles.js";
import type * as permissionGrantLifecycle from "../permissionGrantLifecycle.js";
import type * as phaseConfiguration from "../phaseConfiguration.js";
import type * as projectCheckpoints from "../projectCheckpoints.js";
import type * as rehearsals from "../rehearsals.js";
import type * as releaseVerification from "../releaseVerification.js";
import type * as reviewConfiguration from "../reviewConfiguration.js";
import type * as reviewEvidence from "../reviewEvidence.js";
import type * as reviewEvidenceActions from "../reviewEvidenceActions.js";
import type * as reviewExceptions from "../reviewExceptions.js";
import type * as reviewOperations from "../reviewOperations.js";
import type * as reviewPush from "../reviewPush.js";
import type * as reviewPushState from "../reviewPushState.js";
import type * as reviewRoundPauses from "../reviewRoundPauses.js";
import type * as reviewSubstitutions from "../reviewSubstitutions.js";
import type * as reviewer from "../reviewer.js";
import type * as rosters from "../rosters.js";
import type * as roundExportActions from "../roundExportActions.js";
import type * as roundExports from "../roundExports.js";
import type * as scoreGovernance from "../scoreGovernance.js";
import type * as support from "../support.js";
import type * as synesthesiaConfiguration from "../synesthesiaConfiguration.js";
import type * as synesthesiaOperations from "../synesthesiaOperations.js";
import type * as synesthesiaParticipant from "../synesthesiaParticipant.js";
import type * as system from "../system.js";
import type * as teams from "../teams.js";
import type * as values from "../values.js";
import type * as workpools from "../workpools.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  access: typeof access;
  accessInvitations: typeof accessInvitations;
  accessRoles: typeof accessRoles;
  accessSubjects: typeof accessSubjects;
  admissionIntelligence: typeof admissionIntelligence;
  admissionPolicyConfiguration: typeof admissionPolicyConfiguration;
  admissions: typeof admissions;
  attendanceActions: typeof attendanceActions;
  attendanceConfiguration: typeof attendanceConfiguration;
  attendanceCredentials: typeof attendanceCredentials;
  attendanceExportActions: typeof attendanceExportActions;
  attendanceExports: typeof attendanceExports;
  attendanceManualSheetActions: typeof attendanceManualSheetActions;
  attendanceManualSheets: typeof attendanceManualSheets;
  attendanceOperations: typeof attendanceOperations;
  attendanceParticipant: typeof attendanceParticipant;
  attendancePortalQr: typeof attendancePortalQr;
  attendanceReconciliation: typeof attendanceReconciliation;
  attendanceRemedies: typeof attendanceRemedies;
  attendanceRollCalls: typeof attendanceRollCalls;
  attendanceScan: typeof attendanceScan;
  attendanceScanner: typeof attendanceScanner;
  attendanceSecurity: typeof attendanceSecurity;
  attendanceSessions: typeof attendanceSessions;
  attendanceVenueCheckIns: typeof attendanceVenueCheckIns;
  auth: typeof auth;
  checkpointConfiguration: typeof checkpointConfiguration;
  communicationsPolicyConfiguration: typeof communicationsPolicyConfiguration;
  crons: typeof crons;
  emergencyPackActions: typeof emergencyPackActions;
  emergencyPacks: typeof emergencyPacks;
  eventLifecycle: typeof eventLifecycle;
  figmaActions: typeof figmaActions;
  figmaIntegrations: typeof figmaIntegrations;
  figmaWebhook: typeof figmaWebhook;
  floorConfiguration: typeof floorConfiguration;
  floorMapping: typeof floorMapping;
  floorOperations: typeof floorOperations;
  floorParticipant: typeof floorParticipant;
  generatedHandbook: typeof generatedHandbook;
  githubActions: typeof githubActions;
  githubIntegrations: typeof githubIntegrations;
  githubWebhook: typeof githubWebhook;
  handbook: typeof handbook;
  http: typeof http;
  identityClaims: typeof identityClaims;
  incidents: typeof incidents;
  intake: typeof intake;
  intakeConfiguration: typeof intakeConfiguration;
  intakePolicyConfiguration: typeof intakePolicyConfiguration;
  integrationOperations: typeof integrationOperations;
  intelligence: typeof intelligence;
  "lib/accessVersion": typeof lib_accessVersion;
  "lib/admission": typeof lib_admission;
  "lib/admissionPolicy": typeof lib_admissionPolicy;
  "lib/admissionRecommendation": typeof lib_admissionRecommendation;
  "lib/artifactStorage": typeof lib_artifactStorage;
  "lib/attendance": typeof lib_attendance;
  "lib/attendanceCounters": typeof lib_attendanceCounters;
  "lib/attendanceCredentialLifecycle": typeof lib_attendanceCredentialLifecycle;
  "lib/attendanceOfflineReplay": typeof lib_attendanceOfflineReplay;
  "lib/attendancePlan": typeof lib_attendancePlan;
  "lib/attendancePortalQrLifecycle": typeof lib_attendancePortalQrLifecycle;
  "lib/attendanceRollCalls": typeof lib_attendanceRollCalls;
  "lib/attendanceSessionLifecycle": typeof lib_attendanceSessionLifecycle;
  "lib/attendanceSessionTransition": typeof lib_attendanceSessionTransition;
  "lib/attendanceStations": typeof lib_attendanceStations;
  "lib/attendanceTeamAvailability": typeof lib_attendanceTeamAvailability;
  "lib/audit": typeof lib_audit;
  "lib/cloudflareEmailSending": typeof lib_cloudflareEmailSending;
  "lib/communicationsPolicy": typeof lib_communicationsPolicy;
  "lib/csv": typeof lib_csv;
  "lib/emergencyPack": typeof lib_emergencyPack;
  "lib/eventLifecycle": typeof lib_eventLifecycle;
  "lib/events": typeof lib_events;
  "lib/figmaCheckpointComparison": typeof lib_figmaCheckpointComparison;
  "lib/figmaEvidenceBrowser": typeof lib_figmaEvidenceBrowser;
  "lib/figmaMetadataSchedule": typeof lib_figmaMetadataSchedule;
  "lib/figmaTeamMetrics": typeof lib_figmaTeamMetrics;
  "lib/floor": typeof lib_floor;
  "lib/githubClient": typeof lib_githubClient;
  "lib/githubTeamMetrics": typeof lib_githubTeamMetrics;
  "lib/grantScopes": typeof lib_grantScopes;
  "lib/identity": typeof lib_identity;
  "lib/intakePolicy": typeof lib_intakePolicy;
  "lib/intakeQuestions": typeof lib_intakeQuestions;
  "lib/localBrowserFixtures": typeof lib_localBrowserFixtures;
  "lib/novelty": typeof lib_novelty;
  "lib/operations": typeof lib_operations;
  "lib/operationsHealth": typeof lib_operationsHealth;
  "lib/operationsIntelligencePolicy": typeof lib_operationsIntelligencePolicy;
  "lib/operationsIntelligenceValidators": typeof lib_operationsIntelligenceValidators;
  "lib/participantNotificationDelivery": typeof lib_participantNotificationDelivery;
  "lib/participantPolicy": typeof lib_participantPolicy;
  "lib/permissionBundleEntries": typeof lib_permissionBundleEntries;
  "lib/permissionCatalog": typeof lib_permissionCatalog;
  "lib/permissionDelegation": typeof lib_permissionDelegation;
  "lib/permissionGrantLifecycle": typeof lib_permissionGrantLifecycle;
  "lib/permissions": typeof lib_permissions;
  "lib/phaseSchedule": typeof lib_phaseSchedule;
  "lib/projectCheckpointPlan": typeof lib_projectCheckpointPlan;
  "lib/projectText": typeof lib_projectText;
  "lib/providerSecrets": typeof lib_providerSecrets;
  "lib/pushTokens": typeof lib_pushTokens;
  "lib/queueEstimate": typeof lib_queueEstimate;
  "lib/rehearsal": typeof lib_rehearsal;
  "lib/reviewAccess": typeof lib_reviewAccess;
  "lib/reviewParticipantAvailability": typeof lib_reviewParticipantAvailability;
  "lib/reviewRoundPauses": typeof lib_reviewRoundPauses;
  "lib/reviewScores": typeof lib_reviewScores;
  "lib/roundExportFormat": typeof lib_roundExportFormat;
  "lib/staffedParticipantResolution": typeof lib_staffedParticipantResolution;
  "lib/strings": typeof lib_strings;
  "lib/supportCases": typeof lib_supportCases;
  "lib/synesthesia": typeof lib_synesthesia;
  "lib/trackCatalog": typeof lib_trackCatalog;
  "lib/venueCheckInLifecycle": typeof lib_venueCheckInLifecycle;
  localDevelopment: typeof localDevelopment;
  manualReviewRecordActions: typeof manualReviewRecordActions;
  manualReviewRecords: typeof manualReviewRecords;
  novelty: typeof novelty;
  noveltyConfiguration: typeof noveltyConfiguration;
  operationsHealth: typeof operationsHealth;
  operationsIntelligence: typeof operationsIntelligence;
  operationsIntelligenceActions: typeof operationsIntelligenceActions;
  operationsIntelligenceAutomation: typeof operationsIntelligenceAutomation;
  operationsIntelligencePolicyConfiguration: typeof operationsIntelligencePolicyConfiguration;
  operationsIntelligenceWebhook: typeof operationsIntelligenceWebhook;
  participantCommunications: typeof participantCommunications;
  participantEmail: typeof participantEmail;
  participantEmailEvent: typeof participantEmailEvent;
  participantNotificationState: typeof participantNotificationState;
  participantNotifications: typeof participantNotifications;
  participantPolicyConfiguration: typeof participantPolicyConfiguration;
  participantReview: typeof participantReview;
  participants: typeof participants;
  permissionBundleMigrations: typeof permissionBundleMigrations;
  permissionBundles: typeof permissionBundles;
  permissionGrantLifecycle: typeof permissionGrantLifecycle;
  phaseConfiguration: typeof phaseConfiguration;
  projectCheckpoints: typeof projectCheckpoints;
  rehearsals: typeof rehearsals;
  releaseVerification: typeof releaseVerification;
  reviewConfiguration: typeof reviewConfiguration;
  reviewEvidence: typeof reviewEvidence;
  reviewEvidenceActions: typeof reviewEvidenceActions;
  reviewExceptions: typeof reviewExceptions;
  reviewOperations: typeof reviewOperations;
  reviewPush: typeof reviewPush;
  reviewPushState: typeof reviewPushState;
  reviewRoundPauses: typeof reviewRoundPauses;
  reviewSubstitutions: typeof reviewSubstitutions;
  reviewer: typeof reviewer;
  rosters: typeof rosters;
  roundExportActions: typeof roundExportActions;
  roundExports: typeof roundExports;
  scoreGovernance: typeof scoreGovernance;
  support: typeof support;
  synesthesiaConfiguration: typeof synesthesiaConfiguration;
  synesthesiaOperations: typeof synesthesiaOperations;
  synesthesiaParticipant: typeof synesthesiaParticipant;
  system: typeof system;
  teams: typeof teams;
  values: typeof values;
  workpools: typeof workpools;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  betterAuth: import("@convex-dev/better-auth/_generated/component.js").ComponentApi<"betterAuth">;
  intakeWorkpool: import("@convex-dev/workpool/_generated/component.js").ComponentApi<"intakeWorkpool">;
  admissionWorkpool: import("@convex-dev/workpool/_generated/component.js").ComponentApi<"admissionWorkpool">;
  integrationWorkpool: import("@convex-dev/workpool/_generated/component.js").ComponentApi<"integrationWorkpool">;
  exportWorkpool: import("@convex-dev/workpool/_generated/component.js").ComponentApi<"exportWorkpool">;
  intelligenceWorkpool: import("@convex-dev/workpool/_generated/component.js").ComponentApi<"intelligenceWorkpool">;
};

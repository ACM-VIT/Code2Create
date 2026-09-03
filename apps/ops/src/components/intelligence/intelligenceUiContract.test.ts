import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const liveConsoleSource = read("./LiveAgentConsole.tsx");
const copilotConsoleSource = read("../OperationsCopilotConsole.tsx");
const commandTraySource = read("./CopilotCommandTray.tsx");
const recommendationSource = read("./RecommendationCard.tsx");
const recommendationPresentationSource = read("../../lib/recommendationPresentation.ts");
const briefSource = read("../OperationsBrief.tsx");
const autonomyStreamSource = read("../OperationsAutonomyRunStream.tsx");
const autonomyRunsSource = read("./AutonomyRuns.tsx");
const autonomyRunNowSource = read("./AutonomyRunNow.tsx");
const manualBriefHistorySource = read("./ManualBriefHistory.tsx");
const pendingHookSource = read("./usePendingRecommendations.ts");
const controlPlaneSource = read("./AgentControlPlane.tsx");
const workspaceSource = read("../../screens/IntelligenceWorkspace.tsx");
const overviewSource = read("../../screens/IntelligenceOverview.tsx");
const decisionsSource = read("../../screens/IntelligenceDecisions.tsx");
const situationsSource = read("../../screens/IntelligenceSituations.tsx");
const activitySource = read("../../screens/IntelligenceActivity.tsx");
const policySource = read("../../screens/IntelligencePolicyConfiguration.tsx");
const policyFieldsSource = read("./AutonomyPolicyFields.tsx");
const appSource = read("../../App.tsx");
const stylesheet = read("../../index.css");

test("the operations agent is organised by operator intent, with a deep link for every view", () => {
  assert.match(appSource, /path="\/intelligence\/\*"/);
  assert.match(appSource, /canConfigure=\{canViewIntelligenceConfiguration\}/);
  assert.match(workspaceSource, /<Routes>/);
  assert.match(workspaceSource, /index\n/);
  for (const view of ["ask", "decisions", "situations", "activity"]) {
    assert.match(workspaceSource, new RegExp(`path="${view}"`), `missing ${view} route`);
  }
  assert.match(workspaceSource, /<Navigate replace to=\{intelligencePath\} \/>/);
  for (const label of ["Overview", "Ask", "Decisions", "Situations", "Activity"]) {
    assert.match(workspaceSource, new RegExp(`label: ["']${label}["']`), `missing ${label} tab`);
  }
  assert.match(workspaceSource, /usePendingRecommendations\(canRead\)/);
  assert.match(workspaceSource, /badge:\s+pending\.count === 0 \? undefined/);
  assert.match(workspaceSource, /api\.operationsAutonomy\.status/);
  assert.match(workspaceSource, /autonomyStatusSummary\(autonomy/);
  assert.match(workspaceSource, /<IntelligenceOverview/);
  assert.match(workspaceSource, /<IntelligenceDecisions \/>/);
  assert.match(workspaceSource, /<IntelligenceSituations \/>/);
  assert.match(workspaceSource, /<IntelligenceActivity\s+autonomy=\{autonomy\}/);
  assert.doesNotMatch(workspaceSource, /useState<IntelligenceTab>/);
  assert.doesNotMatch(workspaceSource, /showBrief/);
});

test("the overview is a dispatch surface: one sentence, then ask, decide, watch, and the brief", () => {
  assert.match(overviewSource, /It\s+never changes the event on its own\./);
  assertUsesClasses(overviewSource, [
    "attention-section",
    "section-heading",
    "health-list",
    "list-row",
    "row-action",
    "attention-view-all",
    "health-empty",
  ]);
  for (const heading of ["Needs your decision", "Watching"]) {
    assert.match(overviewSource, new RegExp(`>${heading}</h2>`), `missing ${heading} section`);
  }
  assert.match(briefSource, />Latest brief<\/h2>/);
  assert.match(briefSource, /id="latest-brief"/);
  assert.match(overviewSource, /to="\/intelligence\/decisions"/);
  assert.match(overviewSource, /to="\/intelligence\/situations"/);
  assert.match(overviewSource, /navigate\(["']\/intelligence\/ask["'], \{ state: \{ prompt \} \}\)/);
  assert.match(overviewSource, /overviewPrompts\.map/);
  assert.match(
    overviewSource,
    /<OperationsBrief canGenerate=\{canGenerate\} canRead=\{canRead\} \/>/,
  );
  assert.match(overviewSource, /api\.operationsEpisodes\.relevant/);
  assert.match(overviewSource, /Nothing is waiting for you\./);
  assert.match(overviewSource, /needs the intelligence read permission/);
  assert.match(activitySource, /<AutonomyRunNow autonomy=\{autonomy\}/);
  assert.match(activitySource, /to="\/configuration\/intelligence"/);
  assert.doesNotMatch(
    `${overviewSource}\n${decisionsSource}\n${situationsSource}\n${activitySource}\n${recommendationSource}\n${commandTraySource}\n${controlPlaneSource}\n${autonomyRunsSource}\n${briefSource}`,
    /uppercase|tracking-\[/,
  );
});

test("a question typed on the overview is sent once by the conversation view", () => {
  assert.match(workspaceSource, /promptFromNavigationState\(location\.state\)/);
  assert.match(workspaceSource, /navigate\(location\.pathname, \{ replace: true, state: null \}\)/);
  assert.match(copilotConsoleSource, /autoSubmitPrompt: initialPrompt/);
  assert.match(copilotConsoleSource, /suggestions=\{copilotSuggestedPrompts\}/);
  assert.match(liveConsoleSource, /autoSubmittedRef\.current === autoSubmitPrompt/);
  assert.match(liveConsoleSource, /Suggested questions/);
  assert.match(
    liveConsoleSource,
    /onSuggestion=\{\s*onSubmitPrompt === undefined \|\| composerDisabled \? undefined : sendSuggestion\s*\}/,
  );
});

test("intelligence surfaces compose the established operations primitives", () => {
  assert.match(liveConsoleSource, /from ["']streamdown["']/);
  assert.match(liveConsoleSource, /<Streamdown/);
  assertUsesClasses(liveConsoleSource, [
    "justify-end",
    "rounded-xl",
    "bg-field",
    "text-ink",
    "border-line",
    "field-sizing-content",
    "animate-spin",
    "notice error",
  ]);
  assertUsesClasses(recommendationSource, ["primary", "secondary", "notice error"]);
  assertUsesClasses(briefSource, [
    "health-list",
    "list-row",
    "row-glyph",
    "row-text",
    "state-label",
    "secondary",
    "text-button",
  ]);
  assertUsesClasses(`${activitySource}\n${autonomyRunsSource}\n${manualBriefHistorySource}`, [
    "health-empty",
    "health-list",
    "list-row",
    "row-glyph",
    "row-text",
    "row-controls",
    "state-label",
    "secondary",
    "notice",
  ]);
  assertUsesClasses(`${decisionsSource}\n${situationsSource}\n${overviewSource}`, [
    "health-empty",
    "state-label",
    "secondary",
    "notice",
  ]);
});

test("intelligence keeps the legacy skins removed and ships the chat surface", () => {
  const componentSources = [
    liveConsoleSource,
    recommendationSource,
    briefSource,
    autonomyStreamSource,
    autonomyRunsSource,
    manualBriefHistorySource,
    activitySource,
    decisionsSource,
    situationsSource,
    overviewSource,
    workspaceSource,
  ].join("\n");
  const removedClassNames = [
    "agent-instance-list",
    "copilot-instance",
    "intelligence-console-answer",
    "intelligence-console-duration",
    "intelligence-console-item-dot",
    "intelligence-console-kicker",
    "intelligence-console-mark",
    "intelligence-console-operator",
    "intelligence-console-send",
    "intelligence-console-state-chip",
    "intelligence-console-streaming",
    "intelligence-console-terminal",
    "intelligence-console-tool",
    "intelligence-recommendation",
    "intelligence-recommendation-actions",
    "intelligence-recommendation-card",
    "intelligence-recommendation-note",
    "intelligence-recommendation-state",
    "intelligence-situation",
    "intelligence-brief",
    "intelligence-instance",
    "intelligence-activity-shell",
    "intelligence-priorities",
  ];

  for (const className of removedClassNames) {
    assert.equal(componentSources.includes(className), false, `${className} must stay removed`);
    assert.equal(
      stylesheet.includes(`.${className}`),
      false,
      `.${className} css must stay removed`,
    );
  }

  assert.ok(
    stylesheet.includes('@import "tailwindcss/utilities.css"'),
    "the chat surface is styled with Tailwind utilities",
  );
  assert.ok(stylesheet.includes("--color-ink"), "the intelligence color tokens must exist");
  assert.equal(stylesheet.includes(".ic-"), false, "bespoke ic- chat CSS must stay removed");
  assert.match(
    stylesheet,
    /\.operations-shell:has\(\.intelligence-workspace\) \{\s*display: flex;\s*flex-direction: column;\s*\}/,
  );
});

test("the reusable trace does not mislabel every agent as the copilot", () => {
  assert.match(liveConsoleSource, /agentLabel = ["']Copilot["']/);
  assert.match(liveConsoleSource, /\{agentLabel\} said:/);
  assert.doesNotMatch(liveConsoleSource, /<strong>Copilot<\/strong>/);
  assert.match(read("../OperationsBriefStream.tsx"), /agentLabel="Brief agent"/);
  assert.match(autonomyStreamSource, /agentLabel="Autonomous agent"/);
  assert.match(autonomyStreamSource, /autonomyRunTerminalState\(run\.state\)/);
  assert.match(autonomyStreamSource, /run\.shutdownState === ["']pending["']/);
  assert.match(autonomyStreamSource, /run\.shutdownState === ["']not_required["']/);
  assert.match(autonomyStreamSource, /stop request is still being retried/);
  assert.match(autonomyStreamSource, /never started, so no stop request was needed/);
  assert.match(
    autonomyStreamSource,
    /stop request was recorded, and this run no longer has event access/,
  );
  assert.doesNotMatch(autonomyStreamSource, /shutdown is confirmed/);
  assert.doesNotMatch(autonomyStreamSource, /intelligenceTerminalState\(stream\.settlements\)/);
});

test("the reusable trace exposes complete paged history without losing the reading position", () => {
  const streamHookSource = read("../../lib/useIntelligenceStream.ts");
  assert.match(liveConsoleSource, /Load earlier activity/);
  assert.match(liveConsoleSource, /historyAnchorRef/);
  assert.match(liveConsoleSource, /useLayoutEffect/);
  assert.match(streamHookSource, /loadOlderIntelligenceHistory/);
  assert.match(streamHookSource, /mergeIntelligenceHistoryMessages/);
  assert.match(streamHookSource, /current\.olderPagesLoaded/);
  assert.match(autonomyStreamSource, /historyCanLoadMore=\{stream\.historyCanLoadMore\}/);
});

test("an uncertain copilot send presents one idempotent retry state", () => {
  assert.match(
    liveConsoleSource,
    /Delivery was interrupted\. Retry this same message; it cannot be sent twice\./,
  );
  assert.match(liveConsoleSource, /composerPendingConfirmation\s*\? ["']Retry same message["']/);
  assert.match(liveConsoleSource, /submitFailed && !composerPendingConfirmation/);
  assert.doesNotMatch(liveConsoleSource, /previous send may have committed/i);
});

test("Ask keeps operator-scoped command approval inline with explicit recovery and breathing room", () => {
  assert.match(copilotConsoleSource, /timelineFooter: <CopilotCommandTray \/>/);
  assert.match(commandTraySource, /api\.intelligenceRecommendations\.copilotConversation/);
  assert.match(commandTraySource, /api\.intelligenceRecommendations\.approve/);
  assert.match(commandTraySource, /api\.intelligenceRecommendations\.reject/);
  assert.match(commandTraySource, /operations\.hasPending\(approveSlot\)/);
  assert.match(commandTraySource, /operations\.retryPending\(pendingSlot\)/);
  assert.match(commandTraySource, /Permissions, lifecycle, and versions are checked again\./);
  assert.match(commandTraySource, /recommendationCommandRows\(command\.arguments\)/);
  assert.match(recommendationPresentationSource, /command\.expectedEventVersion/);
  assert.match(recommendationPresentationSource, /command\.expectedBasePolicyId/);
  assert.match(liveConsoleSource, /className="pt-3 pb-2"/);
  assert.match(liveConsoleSource, /["']shrink-0 px-4 pt-2 pb-8["']/);
  assert.doesNotMatch(commandTraySource, /style=\{/);
});

test("the setup surface configures effect-bounded autonomy, not cognitive quotas", () => {
  const completePolicySource = `${policySource}\n${policyFieldsSource}`;
  assert.match(policySource, /api\.operationsAutonomyPolicyConfiguration/);
  assert.match(policyFieldsSource, /Authority boundary/);
  assert.match(policyFieldsSource, /investigate as deeply as needed/);
  assert.match(policyFieldsSource, /cannot\s+change access, identity, participant/);
  assert.doesNotMatch(completePolicySource, /label="Model calls"/);
  assert.doesNotMatch(
    completePolicySource,
    /Logical model turns|maximumModelCalls|maximumToolCalls|maximumReadBytes|maximumWallClock|maximumRecommendations|maximumDelegations/u,
  );
  assert.match(policySource, /Stop (autonomy|the agent)/);
  assert.match(policySource, /api\.operationsAutonomyPolicyConfiguration\.ownerOptionsPage/);
  assert.match(policySource, /usePaginatedQuery/);
  assert.match(policyFieldsSource, /Search by display name/);
  assert.match(policyFieldsSource, /Load more accounts/);
  assert.doesNotMatch(policySource, /configuration\.ownerOptions/);
  assert.match(policyFieldsSource, /The agent cannot execute them/);
  assert.match(policyFieldsSource, /operationsAutonomyReadTools/);
  assert.match(policyFieldsSource, /const readToolOptions = operationsAutonomyReadTools/);
  assert.match(policyFieldsSource, /const areaOptions = operationsHealthAreas/);
  assert.match(policyFieldsSource, /const severityOptions = operationsHealthSeverities/);
  assert.doesNotMatch(policyFieldsSource, /const readToolOptions = \[/);
  assert.doesNotMatch(policySource, /operationsIntelligencePolicyConfiguration/);
  assert.doesNotMatch(
    completePolicySource,
    /execute.safe|allowedSafeActions|maximumSafeExecutions/u,
  );
});

test("autonomy uses the existing activity and recommendation primitives", () => {
  assert.match(activitySource, /api\.operationsAutonomy\.history/);
  assert.match(activitySource, /api\.operationsAutonomy\.queuedWork/);
  assert.match(activitySource, /!autonomy\.available/);
  assert.match(activitySource, /AutonomyRunInspection/);
  assert.match(activitySource, /Load older (autonomous )?runs/);
  assert.match(activitySource, /<ManualBriefHistory \/>/);
  assert.match(autonomyRunNowSource, /api\.operationsAutonomy\.startManual/);
  assert.match(autonomyRunNowSource, /disabled=\{!autonomy\.canStart && !pending\}/);
  assert.match(autonomyRunNowSource, /Confirm earlier request/);
  assert.match(pendingHookSource, /api\.intelligenceRecommendations\.proposed/);
  assert.match(decisionsSource, /api\.intelligenceRecommendations\.settled/);
  assert.match(decisionsSource, /Load more pending recommendations/);
  assert.match(decisionsSource, /Load older decisions/);
  assert.match(recommendationSource, /api\.operationsAutonomyRecommendationEvidence\.observations/);
  assert.match(recommendationSource, /api\.operationsAutonomyRecommendationEvidence\.page/);
  assert.match(recommendationSource, /Load more supporting observations/);
  assert.match(recommendationSource, /Load more exact evidence/);
  assert.match(recommendationSource, /observation\.statement/);
  assert.match(recommendationSource, /observation\.reasoning/);
  assert.match(recommendationSource, /observation\.agentVersion/);
  assert.match(recommendationSource, /observation\.model/);
  assert.match(recommendationSource, /observation\.observedAt/);
  assert.match(autonomyRunsSource, /OperationsAutonomyRunStream/);
  assert.doesNotMatch(
    `${activitySource}\n${autonomyRunsSource}`,
    /modelCalls|Logical model turns|run\.limits|Budget reached/u,
  );
  assert.match(autonomyRunsSource, /run\.sourceGeneratedAt/);
  assert.match(autonomyRunsSource, /run\.policyChecksum/);
  assert.match(`${autonomyRunsSource}\n${manualBriefHistorySource}`, /className="health-list"/);
  assert.match(manualBriefHistorySource, /api\.intelligenceObservability\.briefHistory/);
  assert.match(manualBriefHistorySource, /Load older manual briefs/);
  assert.doesNotMatch(activitySource, /execute|autopilot-card|machine-brain/u);
});

test("a proposal reads as a decision: statement and command first, evidence one disclosure away", () => {
  assert.match(recommendationSource, /Evidence and provenance/);
  assert.match(recommendationSource, /<details className="group rounded-lg border border-line">/);
  assert.match(recommendationSource, /Approve and execute/);
  assert.match(recommendationSource, /Suggest a change/);
  assert.match(recommendationSource, /Confirm the earlier approval/);
  assert.match(recommendationSource, /operations\.retryPending\(pendingSlot\)/);
  assert.match(recommendationSource, /collapsed = false/);
  assert.match(decisionsSource, /<RecommendationCard\n\s+collapsed/);
  assert.match(situationsSource, /Next step · /);
  assert.match(situationsSource, /Analyst reasoning/);
  assert.match(situationsSource, /api\.operationsEpisodes\.calibration/);
});

test("the agent control plane is the engine room, not the landing page", () => {
  assert.match(activitySource, /<AgentControlPlane \/>/);
  assert.doesNotMatch(workspaceSource, /AgentControlPlane/);
  assert.match(controlPlaneSource, /intelligenceAgentDefinitions/);
  assert.match(controlPlaneSource, /api\.intelligenceObservability\.agentFleetStatus/);
  assert.match(controlPlaneSource, /api\.intelligenceObservability\.agentRunHistory/);
  assert.match(controlPlaneSource, /Load older runs/);
  assert.match(controlPlaneSource, /What it may do/);
  assert.match(controlPlaneSource, /What it remembers/);
  assert.match(controlPlaneSource, /agent\.management\.href/);
  assert.match(controlPlaneSource, /role="tablist"/);
  assert.match(controlPlaneSource, /function PromptText/);
  assert.doesNotMatch(controlPlaneSource, /<pre/);
  assert.match(controlPlaneSource, /Deployed agents/);
  assert.doesNotMatch(
    controlPlaneSource,
    /Operations intelligence|Deployed configuration|Code-owned release|Authoritative ledger/,
  );
  assert.doesNotMatch(controlPlaneSource, /<aside/);
  assert.doesNotMatch(controlPlaneSource, /sticky top-/);
  assert.doesNotMatch(stylesheet, /agent-control-plane|agent-fleet|agent-run-ledger/u);
});

function assertUsesClasses(source: string, classNames: readonly string[]) {
  for (const className of classNames) {
    assert.match(
      source,
      new RegExp(`className=[^\\n]+${className}`),
      `missing shared class ${className}`,
    );
  }
}

function read(relativePath: string) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

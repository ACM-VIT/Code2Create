import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const liveConsoleSource = read('./LiveAgentConsole.tsx')
const recommendationSource = read('./RecommendationCard.tsx')
const recommendationQueuesSource = read('./RecommendationQueues.tsx')
const briefSource = read('../OperationsBrief.tsx')
const autonomyStreamSource = read('../OperationsAutonomyRunStream.tsx')
const autonomyRunsSource = read('./AutonomyRuns.tsx')
const manualBriefHistorySource = read('./ManualBriefHistory.tsx')
const activitySource = read('../../screens/IntelligenceActivity.tsx')
const policySource = read('../../screens/IntelligencePolicyConfiguration.tsx')
const policyFieldsSource = read('./AutonomyPolicyFields.tsx')
const controlPlaneSource = read('./AgentControlPlane.tsx')
const workspaceSource = read('../../screens/IntelligenceWorkspace.tsx')
const stylesheet = read('../../index.css')

test('intelligence surfaces compose the established operations primitives', () => {
  assert.match(liveConsoleSource, /from 'streamdown'/)
  assert.match(liveConsoleSource, /<Streamdown/)
  assertUsesClasses(liveConsoleSource, [
    'justify-end',
    'rounded-xl',
    'bg-field',
    'text-ink',
    'border-line',
    'field-sizing-content',
    'animate-spin',
    'notice error',
  ])
  assertUsesClasses(recommendationSource, [
    'card-surface',
    'section-heading',
    'state-label',
    'criteria-list',
    'review-progress',
    'review-list',
    'field',
    'button-row',
    'primary',
    'secondary',
    'notice error',
  ])
  assertUsesClasses(briefSource, [
    'card-surface',
    'section-heading',
    'health-list',
    'list-row',
    'row-glyph',
    'row-text',
    'state-label',
    'secondary',
    'text-button',
  ])
  assertUsesClasses(`${activitySource}\n${autonomyRunsSource}\n${recommendationQueuesSource}\n${manualBriefHistorySource}`, [
    'health-heading',
    'health-current',
    'attention-section',
    'section-heading',
    'health-empty',
    'health-list',
    'list-row',
    'row-glyph',
    'row-text',
    'configuration-card-stack',
    'notice',
  ])
})

test('intelligence keeps the legacy console skin removed and ships the chat surface', () => {
  const componentSources = [
    liveConsoleSource,
    recommendationSource,
    briefSource,
    autonomyStreamSource,
    autonomyRunsSource,
    manualBriefHistorySource,
    activitySource,
  ]
    .join('\n')
  const removedClassNames = [
    'agent-instance-list',
    'copilot-instance',
    'intelligence-console-answer',
    'intelligence-console-duration',
    'intelligence-console-item-dot',
    'intelligence-console-kicker',
    'intelligence-console-mark',
    'intelligence-console-operator',
    'intelligence-console-send',
    'intelligence-console-state-chip',
    'intelligence-console-streaming',
    'intelligence-console-terminal',
    'intelligence-console-tool',
    'intelligence-recommendation-actions',
    'intelligence-recommendation-card',
    'intelligence-recommendation-note',
    'intelligence-recommendation-state',
  ]

  for (const className of removedClassNames) {
    assert.equal(componentSources.includes(className), false, `${className} must stay removed`)
  }

  assert.ok(
    stylesheet.includes('@import "tailwindcss/utilities.css"'),
    'the chat surface is styled with Tailwind utilities',
  )
  assert.ok(stylesheet.includes('--color-ink'), 'the intelligence color tokens must exist')
  assert.equal(stylesheet.includes('.ic-'), false, 'bespoke ic- chat CSS must stay removed')
})

test('the reusable trace does not mislabel every agent as the copilot', () => {
  assert.match(liveConsoleSource, /agentLabel = 'Copilot'/)
  assert.match(liveConsoleSource, /\{agentLabel\} said:/)
  assert.doesNotMatch(liveConsoleSource, /<strong>Copilot<\/strong>/)
  assert.match(read('../OperationsBriefStream.tsx'), /agentLabel="Brief agent"/)
  assert.match(autonomyStreamSource, /agentLabel="Autonomous agent"/)
  assert.match(autonomyStreamSource, /autonomyRunTerminalState\(run\.state\)/)
  assert.match(autonomyStreamSource, /run\.shutdownState === 'pending'/)
  assert.match(autonomyStreamSource, /run\.shutdownState === 'not_required'/)
  assert.match(autonomyStreamSource, /stop request is still being retried/)
  assert.match(autonomyStreamSource, /never started, so no stop request was needed/)
  assert.match(autonomyStreamSource, /stop request was recorded, and this run no longer has event access/)
  assert.doesNotMatch(autonomyStreamSource, /shutdown is confirmed/)
  assert.doesNotMatch(autonomyStreamSource, /intelligenceTerminalState\(stream\.settlements\)/)
})

test('the reusable trace exposes complete paged history without losing the reading position', () => {
  const streamHookSource = read('../../lib/useIntelligenceStream.ts')
  assert.match(liveConsoleSource, /Load earlier activity/)
  assert.match(liveConsoleSource, /historyAnchorRef/)
  assert.match(liveConsoleSource, /useLayoutEffect/)
  assert.match(streamHookSource, /loadOlderIntelligenceHistory/)
  assert.match(streamHookSource, /mergeIntelligenceHistoryMessages/)
  assert.match(streamHookSource, /current\.olderPagesLoaded/)
  assert.match(autonomyStreamSource, /historyCanLoadMore=\{stream\.historyCanLoadMore\}/)
})

test('an uncertain copilot send presents one idempotent retry state', () => {
  assert.match(
    liveConsoleSource,
    /Delivery was interrupted\. Retry this same message; it cannot be sent twice\./,
  )
  assert.match(liveConsoleSource, /composerPendingConfirmation \? 'Retry same message'/)
  assert.match(liveConsoleSource, /submitFailed && !composerPendingConfirmation/)
  assert.doesNotMatch(liveConsoleSource, /previous send may have committed/i)
})

test('the setup surface configures effect-bounded autonomy, not cognitive quotas', () => {
  const completePolicySource = `${policySource}\n${policyFieldsSource}`
  assert.match(policySource, /api\.operationsAutonomyPolicyConfiguration/)
  assert.match(policyFieldsSource, /Authority boundary/)
  assert.match(policyFieldsSource, /investigate as deeply as needed/)
  assert.match(policyFieldsSource, /cannot change access, identity, participant/)
  assert.doesNotMatch(completePolicySource, /label="Model calls"/)
  assert.doesNotMatch(completePolicySource, /Logical model turns|maximumModelCalls|maximumToolCalls|maximumReadBytes|maximumWallClock|maximumRecommendations|maximumDelegations/u)
  assert.match(policySource, /Stop autonomy/)
  assert.match(policySource, /api\.operationsAutonomyPolicyConfiguration\.ownerOptionsPage/)
  assert.match(policySource, /usePaginatedQuery/)
  assert.match(policyFieldsSource, /Search by display name/)
  assert.match(policyFieldsSource, /Load more accounts/)
  assert.doesNotMatch(policySource, /configuration\.ownerOptions/)
  assert.match(policyFieldsSource, /The agent cannot execute them/)
  assert.match(policyFieldsSource, /operationsAutonomyReadTools/)
  assert.match(policyFieldsSource, /const readToolOptions = operationsAutonomyReadTools/)
  assert.match(policyFieldsSource, /const areaOptions = operationsHealthAreas/)
  assert.match(policyFieldsSource, /const severityOptions = operationsHealthSeverities/)
  assert.doesNotMatch(policyFieldsSource, /const readToolOptions = \[/)
  assert.doesNotMatch(policySource, /operationsIntelligencePolicyConfiguration/)
  assert.doesNotMatch(completePolicySource, /execute.safe|allowedSafeActions|maximumSafeExecutions/u)
})

test('autonomy uses the existing activity and recommendation primitives', () => {
  assert.match(activitySource, /api\.operationsAutonomy\.status/)
  assert.match(activitySource, /api\.operationsAutonomy\.history/)
  assert.match(activitySource, /api\.operationsAutonomy\.queuedWork/)
  assert.match(activitySource, /api\.operationsAutonomy\.startManual/)
  assert.match(activitySource, /canGenerate && autonomy\.canStart/)
  assert.match(activitySource, /autonomy\.eventStatus !== 'live'/)
  assert.match(activitySource, /AutonomyRunInspection/)
  assert.match(activitySource, /RecommendationQueues/)
  assert.match(recommendationQueuesSource, /api\.intelligenceRecommendations\.proposed/)
  assert.match(recommendationQueuesSource, /api\.intelligenceRecommendations\.settled/)
  assert.match(recommendationQueuesSource, /Load more pending recommendations/)
  assert.match(recommendationQueuesSource, /Load older decisions/)
  assert.match(recommendationSource, /api\.operationsAutonomyRecommendationEvidence\.observations/)
  assert.match(recommendationSource, /api\.operationsAutonomyRecommendationEvidence\.page/)
  assert.match(recommendationSource, /Load more supporting observations/)
  assert.match(recommendationSource, /Load more exact evidence/)
  assert.match(recommendationSource, /observation\.statement/)
  assert.match(recommendationSource, /observation\.reasoning/)
  assert.match(recommendationSource, /observation\.agentVersion/)
  assert.match(recommendationSource, /observation\.model/)
  assert.match(recommendationSource, /observation\.observedAt/)
  assert.match(autonomyRunsSource, /OperationsAutonomyRunStream/)
  assert.doesNotMatch(`${activitySource}\n${autonomyRunsSource}`, /modelCalls|Logical model turns|run\.limits|Budget reached/u)
  assert.match(autonomyRunsSource, /run\.sourceGeneratedAt/)
  assert.match(autonomyRunsSource, /run\.policyChecksum/)
  assert.match(activitySource, /Load older autonomous runs/)
  assert.match(`${autonomyRunsSource}\n${manualBriefHistorySource}`, /className="health-list"/)
  assert.match(activitySource, /className="row-controls"/)
  assert.match(activitySource, /className="secondary"/)
  assert.match(manualBriefHistorySource, /api\.intelligenceObservability\.briefHistory/)
  assert.match(manualBriefHistorySource, /Load older manual briefs/)
  assert.doesNotMatch(activitySource, /execute|autopilot-card|machine-brain/u)
})

test('the agent control plane exposes every release, prompt, management boundary, and paged run ledger', () => {
  assert.match(workspaceSource, /<AgentControlPlane/)
  assert.match(workspaceSource, /id: 'agents'/)
  assert.match(controlPlaneSource, /intelligenceAgentDefinitions/)
  assert.match(controlPlaneSource, /api\.intelligenceObservability\.agentFleetStatus/)
  assert.match(controlPlaneSource, /api\.intelligenceObservability\.agentRunHistory/)
  assert.match(controlPlaneSource, /Load older runs/)
  assert.match(controlPlaneSource, /Deployed configuration/)
  assert.match(controlPlaneSource, /Authority boundary/)
  assert.match(controlPlaneSource, /Durable memory/)
  assert.match(controlPlaneSource, /Code-owned release/)
  assert.match(controlPlaneSource, /Management boundary/)
  assert.match(controlPlaneSource, /className="mx-auto grid/)
  assert.doesNotMatch(stylesheet, /agent-control-plane|agent-fleet|agent-run-ledger/u)
})

function assertUsesClasses(source: string, classNames: readonly string[]) {
  for (const className of classNames) {
    assert.match(source, new RegExp(`className=[^\\n]+${className}`), `missing shared class ${className}`)
  }
}

function read(relativePath: string) {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8')
}

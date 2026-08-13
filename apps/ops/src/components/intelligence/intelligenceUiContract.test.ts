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
const stylesheet = read('../../index.css')

test('intelligence surfaces compose the established operations primitives', () => {
  assertUsesClasses(liveConsoleSource, [
    'card-surface',
    'section-heading',
    'health-list',
    'list-row',
    'row-glyph',
    'row-text',
    'state-label',
    'field',
    'button-row',
    'primary',
    'row-action',
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

test('intelligence does not restore its former standalone visual skin', () => {
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

  const workspaceStyles = stylesheet.slice(stylesheet.indexOf('/* Intelligence workspace */'))
  assert.notEqual(workspaceStyles, stylesheet, 'intelligence style boundary must exist')
  for (const forbiddenStyle of [
    /(?:radial-|linear-)?gradient\(/,
    /box-shadow\s*:/,
    /text-shadow\s*:/,
    /backdrop-filter\s*:/,
    /font-family\s*:/,
    /animation\s*:/,
    /@keyframes\b/,
    /#[\da-f]{3,8}\b/i,
    /rgba?\(/,
  ]) {
    assert.doesNotMatch(workspaceStyles, forbiddenStyle)
  }

  const intelligenceClasses = new Set(
    Array.from(workspaceStyles.matchAll(/\.intelligence-[a-z\d-]+/g), (match) => match[0]),
  )
  assert.ok(
    intelligenceClasses.size <= 21,
    `intelligence layout grew to ${intelligenceClasses.size} bespoke classes`,
  )
})

test('the reusable trace does not mislabel every agent as the copilot', () => {
  assert.match(liveConsoleSource, /agentLabel = 'Copilot'/)
  assert.match(liveConsoleSource, /<strong>\{agentLabel\}<\/strong>/)
  assert.doesNotMatch(liveConsoleSource, /<strong>Copilot<\/strong>/)
  assert.match(read('../OperationsBriefStream.tsx'), /agentLabel="Brief agent"/)
  assert.match(autonomyStreamSource, /agentLabel="Autonomous agent"/)
  assert.match(autonomyStreamSource, /autonomyRunTerminalState\(run\.state\)/)
  assert.match(autonomyStreamSource, /run\.shutdownState === 'pending'/)
  assert.match(autonomyStreamSource, /run\.shutdownState === 'not_required'/)
  assert.match(autonomyStreamSource, /durable Worker abort is still being retried/)
  assert.match(autonomyStreamSource, /No Worker submission was admitted, so no abort was required/)
  assert.match(autonomyStreamSource, /recorded the durable abort request/)
  assert.doesNotMatch(autonomyStreamSource, /shutdown is confirmed/)
  assert.doesNotMatch(autonomyStreamSource, /intelligenceTerminalState\(stream\.settlements\)/)
})

test('the reusable trace exposes complete paged history without losing the reading position', () => {
  const streamHookSource = read('../../lib/useIntelligenceStream.ts')
  assert.match(liveConsoleSource, /Load older activity/)
  assert.match(liveConsoleSource, /historyAnchorRef/)
  assert.match(liveConsoleSource, /useLayoutEffect/)
  assert.match(streamHookSource, /loadOlderIntelligenceHistory/)
  assert.match(streamHookSource, /mergeIntelligenceHistoryMessages/)
  assert.match(streamHookSource, /current\.olderPagesLoaded/)
  assert.match(autonomyStreamSource, /historyCanLoadMore=\{stream\.historyCanLoadMore\}/)
})

test('the setup surface configures effect-bounded autonomy, not cognitive quotas', () => {
  const completePolicySource = `${policySource}\n${policyFieldsSource}`
  assert.match(policySource, /api\.operationsAutonomyPolicyConfiguration/)
  assert.match(policyFieldsSource, /Authority boundary/)
  assert.match(policyFieldsSource, /have no product quota/)
  assert.match(policyFieldsSource, /cannot change access, identity, participant/)
  assert.doesNotMatch(completePolicySource, /label="Model calls"/)
  assert.doesNotMatch(completePolicySource, /Logical model turns|maximumModelCalls|maximumToolCalls|maximumReadBytes|maximumWallClock|maximumRecommendations|maximumDelegations/u)
  assert.match(policySource, /Stop autonomy/)
  assert.match(policySource, /api\.operationsAutonomyPolicyConfiguration\.ownerOptionsPage/)
  assert.match(policySource, /usePaginatedQuery/)
  assert.match(policyFieldsSource, /Search by display name/)
  assert.match(policyFieldsSource, /Load more accounts/)
  assert.doesNotMatch(policySource, /configuration\.ownerOptions/)
  assert.match(policyFieldsSource, /The agent still cannot execute it/)
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

function assertUsesClasses(source: string, classNames: readonly string[]) {
  for (const className of classNames) {
    assert.match(source, new RegExp(`className=[^\\n]+${className}`), `missing shared class ${className}`)
  }
}

function read(relativePath: string) {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8')
}
